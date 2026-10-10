/**
 * The planner's standing approvals (ADR-0026): what runs without asking
 * anyone, under every approval mode.
 *
 * One entry is one of:
 *
 *   - a **command rule**, `gh issue list` or `gcloud * * list`: the binary,
 *     then words matched against the command's leading arguments, the ones
 *     before its first flag. A command whose leading words match the rule's
 *     runs, whatever arguments follow — but the rule must spell out at least
 *     the words the command's approval scope holds (ADR-0008, T1), so
 *     `az group` never covers `az group delete`, and a one-word read takes a
 *     `*` for its argument (`kubectl get *`). `*` stands for one word, and
 *     inside a word for any run of characters (`describe-*`). An entry equal
 *     to a scope also matches that scope, as pre-approved scopes always did.
 *   - an **MCP tool rule**, `mcp:find-*`: a glob over the tool's own name,
 *     without the server, case-insensitive.
 *   - a **scope pattern**, anything starting with `/`, `~`, `http://`,
 *     `https://`, `mcp__` or a drive letter: matched against an approval's
 *     scope as ADR-0008 always matched pre-approved entries, `*` matching any
 *     run of characters.
 *
 * A leading `!` excludes instead, and an exclusion wins over every rule. A
 * command exclusion's words are looked for anywhere among the arguments, in
 * order, flags included and case ignored, so `!kubectl *secret*` and
 * `!* --endpoint*` hold wherever the word appears; a lone short flag (`-s`)
 * also holds inside a bundle (`-As`, `-shost`). `*` as its binary covers
 * every command.
 */

/** The words a command rule is matched against: a lexed segment's binary and arguments. */
export interface CommandWords {
  binary: string;
  args: readonly string[];
  /** How many leading arguments the command's approval scope holds; a rule must cover at least that many. */
  scopeWords?: number;
}

interface RuleWord {
  matches: (word: string) => boolean;
  wildcard: boolean;
}

interface CommandRule {
  text: string;
  binary: string;
  words: RuleWord[];
}

export interface PlannerAllowlist {
  commands: CommandRule[];
  commandExclusions: CommandRule[];
  tools: RegExp[];
  toolExclusions: RegExp[];
  scopes: RegExp[];
  scopeExclusions: RegExp[];
}

/**
 * A `*` slot never stands for a word that changes something. Without this,
 * `gcloud * * * list` matches `gcloud compute instances delete list`, which
 * deletes the instance named `list`: a CLI that takes positional names lets
 * any read verb be spelled as the name of a write.
 */
const MUTATING_VERB = /^(abort|ack|activate|add|apply|approve|archive|assign|attach|bind|call|cancel|clear|clone|close|commit|copy|cp|create|deactivate|delete|deploy|destroy|detach|disable|download|drain|drop|dump|edit|enable|evict|exec|execute|expire|export|failover|flush|grant|import|insert|install|invoke|kill|label|lock|login|logout|merge|migrate|modify|move|mv|patch|pause|promote|publish|pull|purge|push|put|reboot|redeploy|register|reject|release|remove|rename|reopen|replace|request|reset|resize|restart|restore|resume|revoke|rm|rollback|rotate|run|scale|scp|send|set|ssh|start|stop|submit|suspend|sync|rsync|tag|taint|terminate|transfer|truncate|undelete|uninstall|unlock|unregister|unset|untag|update|upgrade|upload|write)([-_:.].*)?$/i;

function globRegExp(glob: string, flags = ''): RegExp {
  const escaped = glob.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${escaped}$`, flags);
}

function ruleWord(pattern: string): RuleWord {
  if (!pattern.includes('*')) return { matches: (word) => word === pattern, wildcard: false };
  const re = globRegExp(pattern);
  return { matches: (word) => re.test(word), wildcard: true };
}

/** An exclusion's word: case-insensitive, since over-excluding costs only a prompt, and a short flag found in a bundle. */
function exclusionWord(pattern: string): RuleWord {
  const re = /^-[A-Za-z]$/.test(pattern) ? new RegExp(`^-[A-Za-z]*${pattern[1]}`) : globRegExp(pattern, 'i');
  return { matches: (word) => re.test(word), wildcard: pattern.includes('*') };
}

function isScopePattern(entry: string): boolean {
  return /^(\/|~|https?:\/\/|mcp__|[A-Za-z]:[\\/])/.test(entry);
}

export function parseAllowlist(entries: readonly string[]): PlannerAllowlist {
  const list: PlannerAllowlist = { commands: [], commandExclusions: [], tools: [], toolExclusions: [], scopes: [], scopeExclusions: [] };
  for (const raw of entries) {
    const exclude = raw.trim().startsWith('!');
    const entry = raw.trim().replace(/^!\s*/, '');
    if (!entry) continue;
    if (entry.startsWith('mcp:')) {
      (exclude ? list.toolExclusions : list.tools).push(globRegExp(entry.slice(4).trim(), 'i'));
    } else if (isScopePattern(entry)) {
      (exclude ? list.scopeExclusions : list.scopes).push(globRegExp(entry));
    } else {
      const [binary, ...words] = entry.split(/\s+/);
      (exclude ? list.commandExclusions : list.commands).push({ text: raw.trim(), binary, words: words.map(exclude ? exclusionWord : ruleWord) });
    }
  }
  return list;
}

/** The arguments a command names its operation with: those before its first flag. */
function leadingWords(args: readonly string[]): string[] {
  const lead: string[] = [];
  for (const arg of args) {
    if (arg.startsWith('-')) break;
    lead.push(arg);
  }
  return lead;
}

function ruleCovers(rule: CommandRule, command: CommandWords): boolean {
  if (rule.binary !== command.binary) return false;
  const lead = leadingWords(command.args);
  if (lead.length < rule.words.length || rule.words.length < (command.scopeWords ?? 0)) return false;
  return rule.words.every((word, i) => word.matches(lead[i]) && !(word.wildcard && MUTATING_VERB.test(lead[i])));
}

function exclusionCovers(rule: CommandRule, command: CommandWords): boolean {
  if (rule.binary !== '*' && rule.binary !== command.binary) return false;
  let next = 0;
  for (const arg of command.args) {
    if (next < rule.words.length && rule.words[next].matches(arg)) next += 1;
  }
  return next === rule.words.length;
}

/** The rule that lets this command run unasked, or undefined when none does or an exclusion holds. */
export function commandAllowedBy(list: PlannerAllowlist, command: CommandWords): string | undefined {
  if (list.commandExclusions.some((rule) => exclusionCovers(rule, command))) return undefined;
  return list.commands.find((rule) => ruleCovers(rule, command))?.text;
}

/** Whether an MCP tool, by its own name without the server, runs unasked. */
export function toolAllowed(list: PlannerAllowlist, tool: string): boolean {
  if (list.toolExclusions.some((re) => re.test(tool))) return false;
  return list.tools.some((re) => re.test(tool));
}

/** Whether an approval scope — a directory, an origin, a tool's full name — is pre-approved. */
export function scopeAllowed(list: PlannerAllowlist, scope: string): boolean {
  if (list.scopeExclusions.some((re) => re.test(scope))) return false;
  return list.scopes.some((re) => re.test(scope)) || list.commands.some((rule) => rule.text === scope);
}

/** A read with one word, alone and with the argument it names: a multi-level CLI scopes `kubectl get pods` as two words. */
function withArgument(binary: string, verbs: readonly string[]): string[] {
  return verbs.flatMap((verb) => [`${binary} ${verb}`, `${binary} ${verb} *`]);
}

/** `verb` for each read-only verb, at each depth a CLI's command groups nest to. */
function nested(binary: string, verbs: readonly string[], depth: number): string[] {
  return verbs.flatMap((verb) => Array.from({ length: depth }, (_, i) => [binary, ...Array<string>(i).fill('*'), verb].join(' ')));
}

const KUBE_VERB_READS = ['get', 'describe', 'logs', 'top', 'explain', 'events'];
const KUBE_READS = [
  'api-resources', 'api-versions', 'version', 'cluster-info',
  'auth can-i', 'auth whoami', 'config get-contexts', 'config current-context', 'config get-clusters',
  'rollout status', 'rollout history',
];

const CONTAINER_VERB_READS = ['ps', 'images', 'inspect', 'logs', 'history', 'top', 'port'];
const CONTAINER_READS = [
  'version', 'info',
  'image ls', 'image list', 'image inspect', 'image history', 'container ls', 'container list', 'container inspect', 'container logs',
  'network ls', 'network inspect', 'volume ls', 'volume inspect', 'context ls', 'context list',
];

/**
 * Read-only command families that are safe to run unasked: they read, never
 * write a file or change a resource, and need no argument that runs code.
 * Absent on purpose: commands that run the repository's own code (test
 * runners, builds, package scripts, a package manager the repository pins or
 * extends — on an untrusted repository someone else wrote that code), commands
 * a repository's own config can point at another endpoint with the user's
 * credentials (`.npmrc`, `.sentryclirc`, a Terraform or Pulumi backend), and
 * commands whose usual output is a secret.
 */
export const DEFAULT_PLANNER_ALLOWLIST: readonly string[] = [
  // GitHub, GitLab, Jira
  ...['issue list', 'issue view', 'issue status', 'pr list', 'pr view', 'pr diff', 'pr checks', 'pr status',
    'run list', 'run view', 'workflow list', 'workflow view', 'repo view', 'repo list', 'search', 'label list',
    'search *', 'status', 'cache list', 'project list', 'project view', 'project item-list', 'gist list', 'gist view',
    'variable list', 'ruleset list', 'ruleset view', 'org list'].map((c) => `gh ${c}`),
  ...['issue list', 'issue view', 'mr list', 'mr view', 'mr diff', 'ci list', 'ci status', 'repo view',
    'release list', 'release view'].map((c) => `glab ${c}`),
  ...['issue list', 'issue view', 'sprint list', 'epic list', 'project list'].map((c) => `jira ${c}`),
  '!gh -w', '!glab -w',

  // Azure: `az` takes no positional arguments, so a group path is always groups then verb.
  ...nested('az', ['list', 'show'], 5),
  'az version', 'az lock list', 'az tag list', 'az monitor log-analytics query', 'az monitor app-insights query',
  '!az *keys*', '!az *secret*', '!az *credential*', '!az *password*', '!az *connection-string*', '!az *appsettings*', '!az *token*',

  // Google Cloud. `run` is spelled out: a wildcard never stands for it.
  ...nested('gcloud', ['list', 'describe', 'get-iam-policy'], 5),
  'gcloud run * list', 'gcloud run * * list', 'gcloud run * describe', 'gcloud run * * describe',
  'gcloud config list', 'gcloud config get', 'gcloud config get-value', 'gcloud auth list', 'gcloud logging read',
  'gcloud info', 'gcloud version',
  ...['ls', 'du'].map((c) => `gsutil ${c}`),
  ...['ls', 'show', 'head'].map((c) => `bq ${c}`),
  '!gcloud *secret*', '!gcloud *token*',

  // AWS: always `aws <service> <operation>`.
  'aws * describe-*', 'aws * list-*', 'aws s3 ls', 'aws sts get-caller-identity', 'aws configure list',
  'aws logs filter-log-events', 'aws logs get-log-events', 'aws cloudwatch get-metric-data',
  'aws cloudwatch get-metric-statistics', 'aws ce get-cost-and-usage', 'aws iam get-user', 'aws iam get-role',
  '!aws secretsmanager', '!aws *secret*',

  // Other clouds and platforms
  ...nested('doctl', ['list', 'get'], 3), 'doctl account get', '!doctl -u',
  ...nested('hcloud', ['list', 'describe'], 2),
  ...nested('linode-cli', ['list', 'view'], 2),
  ...nested('oci', ['list'], 4),
  ...['status', 'releases', 'apps list', 'machine list', 'machines list', 'secrets list', 'regions list',
    'ips list', 'volumes list'].flatMap((c) => [`fly ${c}`, `flyctl ${c}`]),
  ...['apps', 'apps:info', 'ps', 'logs', 'releases', 'addons', 'domains', 'pipelines'].map((c) => `heroku ${c}`),
  ...['ls', 'list', 'inspect', 'logs', 'env ls', 'domains ls', 'project ls', 'whoami'].map((c) => `vercel ${c}`),
  'netlify status', 'netlify sites:list',
  'firebase projects:list', 'firebase apps:list', 'firebase hosting:channel:list',
  'wrangler whoami', 'wrangler deployments list', 'wrangler d1 list', 'wrangler kv namespace list',
  'supabase projects list', 'supabase functions list', 'railway status',

  // Kubernetes and friends. A kubeconfig the command names can run a credential plugin; `--raw` reads any API path.
  ...withArgument('kubectl', KUBE_VERB_READS), ...KUBE_READS.map((c) => `kubectl ${c}`),
  ...[...KUBE_VERB_READS, ...KUBE_READS, 'status', 'whoami', 'projects'].map((c) => `oc ${c}`),
  ...['kubectl', 'oc'].flatMap((bin) => ['*secret*', '-s', 'dump', '--raw*', '-k', '--kustomize*'].map((w) => `!${bin} ${w}`)),
  '!oc whoami -t', '!oc *show-token*',
  ...withArgument('helm', ['list', 'ls', 'status', 'history', 'search']), 'helm version', '!helm --kube*',
  'eksctl get', 'kind get', 'k3d cluster list', 'minikube status', 'minikube profile list', '!kind *kubeconfig*',
  'argocd app list', 'argocd app get', 'argocd app history',
  'istioctl analyze', 'istioctl proxy-status', 'istioctl version', '!istioctl -c',
  'nomad status', 'nomad job status', 'consul members', 'consul catalog services', 'vault status',

  // Containers. Not `compose`, which reads the repository's compose file, remote includes and all.
  ...['docker', 'podman'].flatMap((bin) => [...withArgument(bin, CONTAINER_VERB_READS), ...CONTAINER_READS.map((c) => `${bin} ${c}`), `!${bin} -H`]),

  // Infrastructure as code: only what reads no backend, whose address the repository's config sets.
  ...['version', 'workspace show'].flatMap((c) => [`terraform ${c}`, `tofu ${c}`]),

  // Package metadata from what is installed: npm reads `node_modules`, pip its own environment.
  ...withArgument('npm', ['ls', 'list', 'why', 'explain']),
  ...['pip', 'pip3'].flatMap((bin) => [...withArgument(bin, ['show']), `${bin} list`, `${bin} freeze`, `!${bin} -i`, `!${bin} -f`]),
  // A module query (`@latest`) fetches from whatever host the module path names.
  ...withArgument('go', ['list', 'env']), 'go version', 'go mod graph', 'go mod why',
  '!go -w', '!go -u', '!go -mod*', '!go *-toolexec*', '!go *-exec*', '!go *-compiled*', '!go *-export*', '!go *@*',

  // The local machine
  'ps', 'lsof', 'uptime', 'free', 'nproc', 'hostname', 'id', 'journalctl',
  '!journalctl --vacuum*', '!journalctl --rotate', '!journalctl --flush', '!journalctl --sync', '!journalctl --relinquish*',
  '!journalctl --smart-relinquish*', '!journalctl --setup-keys', '!journalctl --update-catalog', '!hostname *',

  // Anything that would write a file, open a browser, or send the user's credentials to an address the command names.
  ...['--output-file*', '--out-file*', '--outfile*', '--output-document*', '--output-directory*', '--log-file*', '--logfile*',
    '--download*', '--show-secrets*', '--with-decryption*', '--reveal*', '--web',
    '--server*', '*-addr*', '--endpoint*', '--api-url*', '--url*', '--host*', '--registry*', '--index-url*',
    '--extra-index-url*', '--find-links*', '--proxy*', '--kubeconfig*', '*apiserver*', '*http://*', '*https://*'].map((w) => `!* ${w}`),

  // MCP tools that read: the verb leads the tool's own name.
  ...['get*', 'list*', 'find*', 'search*', 'read*', 'view*', 'describe*', 'show*'].map((v) => `mcp:${v}`),
  ...['*secret*', '*token*', '*password*', '*credential*', '*key*', '*url*', '*fetch*', '*http*'].map((w) => `!mcp:${w}`),
];
