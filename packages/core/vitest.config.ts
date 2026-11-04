import { defineConfig } from 'vitest/config';
import { sharedTest } from '../../vitest.shared';

// Floors for the modules the seam refactors introduced, each at its measured
// value rounded down. The rest of the codebase stays report-only (see ci.yml).
const floor = (lines: number, branches: number, functions: number, statements = lines) => ({
  lines,
  branches,
  functions,
  statements,
  perFile: true,
});

export default defineConfig({
  test: {
    ...sharedTest,
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/__tests__/**', '**/fixtures/**', '**/*.d.ts', 'dist/**'],
      thresholds: {
        'src/conversation/labels.ts': floor(100, 100, 100),
        'src/plugins/builtin/copilot-cli.manifest.ts': floor(100, 100, 100),
        'src/plugins/builtin/copilotModels.ts': floor(100, 100, 100),
        'src/services/PlanEditError.ts': floor(100, 100, 100),
        'src/services/PlanEditor.ts': floor(100, 92, 100),
        'src/services/TaskAssignment.ts': floor(100, 97, 100),
        'src/services/attemptKind.ts': floor(100, 100, 100),
        'src/services/harness/AcpAdapter.ts': floor(100, 87, 100),
        'src/services/harness/acpModels.ts': floor(96, 82, 100),
        'src/services/harness/acpEvents.ts': floor(100, 100, 100),
        'src/services/harness/acpOptions.ts': floor(100, 100, 100),
        'src/services/harness/acpOrdewell.ts': floor(100, 100, 100),
        'src/services/harness/acpPrivateDir.ts': floor(97, 87, 100),
        'src/services/harness/acpProfiles.ts': floor(100, 100, 100),
        'src/services/harness/acpRoles.ts': floor(100, 100, 100),
        'src/services/harness/acpSchema.ts': floor(100, 100, 100),
        'src/services/harness/claudeOrdewell.ts': floor(100, 83, 100),
        'src/services/harness/codexOrdewell.ts': floor(100, 94, 100),
        'src/services/harness/connectors.ts': floor(100, 87, 100),
        'src/services/harness/copilotProfile.ts': floor(100, 100, 100),
        'src/services/harness/jsonRpc.ts': floor(100, 94, 95),
        'src/services/harness/openCodeTransport.ts': floor(100, 97, 94),
        'src/services/harness/ordewellBinding.ts': floor(80, 78, 100),
        'src/services/runState.ts': floor(100, 100, 100),
        'src/taskRow/actions.ts': floor(100, 100, 100),
        'src/taskRow/index.ts': floor(100, 100, 100),
        'src/taskRow/logHeader.ts': floor(100, 100, 100),
        'src/taskRow/status.ts': floor(100, 100, 100),
        'src/taskRow/texts.ts': floor(100, 100, 100),
        'src/taskRow/view.ts': floor(100, 100, 100),
      },
    },
  },
});
