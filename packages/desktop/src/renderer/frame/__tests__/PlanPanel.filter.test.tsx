import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { usePlanFilterActive } from '@ordewell/ui';
import { PlanPanel } from '../PlanPanel';
import { FrameProvider, FrameStore, useFrameState } from '../store';

/** Stands in for a plan card: does the frame tell it a status filter is on? */
function Probe() {
  return <span data-testid="filter-active">{usePlanFilterActive() ? 'active' : 'inactive'}</span>;
}

/** Mimics Frame: PlanPanel is a drawer exactly while layout.drawer is 'plan'. */
function PanelFromState() {
  const { layout } = useFrameState();
  return <PlanPanel drawer={layout.drawer === 'plan'} />;
}

function mount(viewport: { width: number; height: number }) {
  const store = new FrameStore({
    workspace: '/work/acme', platform: 'linux', viewport, persistLayout: () => {},
  });
  store.api.registerPanel({ region: 'plan', id: 'plan', title: 'Plan', render: () => <Probe /> });
  render(<FrameProvider value={store}><PanelFromState /></FrameProvider>);
  return store;
}

/** Only a squeezed plan can be a drawer; a wide window docks it. */
const NARROW = { width: 900, height: 800 };
const WIDE = { width: 1512, height: 982 };

/**
 * The CSS filter (data-filter) and the disclosure state reach the cards from
 * the same rail choice. This proves PlanPanel actually provides the context
 * that keeps a revealed row's aria-expanded honest — a filtered drawer only,
 * never an unfiltered or docked panel.
 */
describe('PlanPanel — filter context for disclosure state', () => {
  it('reports an active filter to the cards only while a filtered drawer is open', () => {
    const store = mount(NARROW);
    const probe = () => screen.getByTestId('filter-active');
    expect(probe()).toHaveTextContent('inactive');

    act(() => store.dispatch({ type: 'drawer', drawer: 'plan', filter: 'running' }));
    expect(probe()).toHaveTextContent('active');
    expect(screen.getByRole('complementary', { name: 'Plan' })).toHaveAttribute('data-filter', 'running');

    act(() => store.dispatch({ type: 'closeDrawer' }));
    expect(probe()).toHaveTextContent('inactive');
  });

  it('never reports a filter in the docked panel, even with a filter value set', () => {
    const store = mount(WIDE);
    // A wide window docks the plan, so no drawer and no filter context.
    act(() => store.dispatch({ type: 'drawer', drawer: 'plan', filter: 'running' }));
    expect(screen.getByTestId('filter-active')).toHaveTextContent('inactive');
  });
});
