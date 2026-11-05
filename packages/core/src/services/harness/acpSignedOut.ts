import type { AcpProfile } from './acpProfiles';

/**
 * What the user is told of an ACP agent that is not signed in: its own login,
 * then the route its profile's credential hook reads. One wording for a start
 * that was refused and for a catalog that lists nothing, so each surface
 * offers the same way in.
 */
export function acpSignedOut(profile: Pick<AcpProfile, 'manifest' | 'signInRoute'>): string {
  const { auth, runner, displayName, name } = profile.manifest;
  const agent = displayName ?? name;
  const routes = [auth ? `run \`${[runner.command, ...auth.loginArgs].join(' ')}\`` : null, profile.signInRoute].filter(Boolean).join(', or ');
  return routes ? `${agent} is not signed in. ${routes[0].toUpperCase()}${routes.slice(1)}.` : `${agent} is not signed in.`;
}
