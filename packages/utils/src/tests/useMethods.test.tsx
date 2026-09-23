import { act, renderHook } from '@testing-library/react';
import { applyPatches } from 'immer';

import { HISTORY_ACTIONS } from '../History';
import {
  Options,
  PatchListener,
  SubscriberAndCallbacksFor,
  useMethods,
} from '../useMethods';

type TestState = {
  nodes: Record<string, { left: number; label: string }>;
  normalized: number;
};

const methods = (state: TestState) => ({
  setLeft(id: string, left: number) {
    state.nodes[id].left = left;
  },
  setState(recipe: (draft: TestState) => void) {
    recipe(state);
  },
});

const queries = (state?: TestState) => ({
  getState: () => state,
});

type TestOptions = Options<TestState, ReturnType<typeof methods>>;
type Guard = TestOptions['validateChange'];
type Listener = PatchListener<TestState, TestOptions, typeof queries>;
type Store = SubscriberAndCallbacksFor<typeof methods, typeof queries>;

const renderStore = (
  validateChange?: Guard,
  extraOptions?: Partial<TestOptions>,
  patchListener?: Listener
) =>
  renderHook(
    ({ guard }: { guard?: Guard }) =>
      useMethods(
        {
          methods,
          ignoreHistoryForActions: [],
          ...extraOptions,
          validateChange: guard,
        },
        {
          nodes: {
            a: { left: 0, label: 'A' },
            b: { left: 0, label: 'B' },
          },
          normalized: 0,
        },
        queries,
        patchListener
      ) as Store,
    { initialProps: { guard: validateChange } }
  );

const capture = (store: Store) => ({
  state: store.query.getState(),
  timeline: store.history.timeline,
  entries: [...store.history.timeline],
  pointer: store.history.pointer,
});

const expectUnchanged = (
  store: Store,
  previous: ReturnType<typeof capture>
) => {
  expect(store.query.getState()).toBe(previous.state);
  expect(store.history.timeline).toBe(previous.timeline);
  expect(store.history.timeline).toEqual(previous.entries);
  expect(store.history.pointer).toBe(previous.pointer);
};

describe('useMethods change validation', () => {
  it('preserves ordinary updates and history when no validator is configured', () => {
    const { result } = renderStore();

    act(() => result.current.actions.setLeft('a', 10));
    act(() => result.current.actions.history.merge().setLeft('b', 20));
    expect(result.current.query.getState().nodes).toMatchObject({
      a: { left: 10 },
      b: { left: 20 },
    });
    expect(result.current.history.timeline).toHaveLength(1);

    act(() => result.current.actions.history.undo());
    expect(result.current.query.getState().nodes.a.left).toBe(0);
    expect(result.current.query.getState().nodes.b.left).toBe(0);
    act(() => result.current.actions.history.redo());
    expect(result.current.query.getState().nodes.b.left).toBe(20);
    act(() => result.current.actions.history.clear());
    expect(result.current.query.history.canUndo()).toBe(false);
  });

  it.each([
    ['ordinary', (store: Store) => store.actions.setLeft('a', 10)],
    [
      'callback batch',
      (store: Store) =>
        store.actions.setState((draft) => {
          draft.nodes.a.left = 10;
          draft.nodes.b.left = 20;
        }),
    ],
    [
      'ignore',
      (store: Store) => store.actions.history.ignore().setLeft('a', 10),
    ],
    ['merge', (store: Store) => store.actions.history.merge().setLeft('a', 10)],
    [
      'throttle',
      (store: Store) => store.actions.history.throttle(1000).setLeft('a', 10),
    ],
  ])('rejects %s writes without notifying subscribers', (_name, write) => {
    const { result, rerender } = renderStore();
    act(() => result.current.actions.setLeft('a', 5));
    rerender({ guard: () => false });
    const previous = capture(result.current);
    const collector = jest.fn((state: TestState) => state);
    const listener = jest.fn();
    result.current.subscribe(collector, listener);

    act(() => write(result.current));

    expectUnchanged(result.current, previous);
    expect(collector).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it('also validates methods excluded from history by configuration', () => {
    const guard = jest.fn(() => false);
    const { result } = renderStore(guard, {
      ignoreHistoryForActions: ['setLeft'],
    });
    const previous = capture(result.current);

    act(() => result.current.actions.setLeft('a', 10));

    expect(guard).toHaveBeenCalledTimes(1);
    expectUnchanged(result.current, previous);
  });

  it('passes the complete normalized draft, patches and original action to the validator', () => {
    const guard = jest.fn<ReturnType<Guard>, Parameters<Guard>>(() => false);
    const patchListener: Listener = (
      _next,
      _previous,
      _action,
      _query,
      normalize
    ) => {
      normalize((draft) => {
        draft.normalized = 1;
      });
      normalize((draft) => {
        draft.nodes.b.label = 'normalized';
      });
    };
    const { result } = renderStore(guard, {}, patchListener);
    const previous = capture(result.current);

    act(() => result.current.actions.history.ignore().setLeft('a', 10));

    const [nextState, previousState, action, patches] = guard.mock.calls[0];
    expect(previousState).toBe(previous.state);
    expect(nextState.normalized).toBe(1);
    expect(nextState.nodes.b.label).toBe('normalized');
    expect(applyPatches(previousState, patches)).toEqual(nextState);
    expect(action).toEqual({
      type: HISTORY_ACTIONS.IGNORE,
      payload: ['setLeft', 'a', 10],
    });
    expectUnchanged(result.current, previous);
  });

  it('validates the final replay normalization and its patches', () => {
    const guard = jest.fn<ReturnType<Guard>, Parameters<Guard>>(() => true);
    const { result } = renderStore(guard, {
      normalizeHistory: (draft) => {
        draft.normalized += 1;
      },
    });
    act(() => result.current.actions.setLeft('a', 10));
    guard.mockClear();

    act(() => result.current.actions.history.undo());

    const [nextState, previousState, action, patches] = guard.mock.calls[0];
    expect(nextState.normalized).toBe(1);
    expect(nextState.nodes.a.left).toBe(0);
    expect(applyPatches(previousState, patches)).toEqual(nextState);
    expect(action.type).toBe(HISTORY_ACTIONS.UNDO);
  });

  it.each(['undo', 'redo', 'clear'] as const)(
    'restores state and history when %s is rejected',
    (operation) => {
      const { result, rerender } = renderStore();
      act(() => result.current.actions.setLeft('a', 10));
      if (operation === 'redo') {
        act(() => result.current.actions.history.undo());
      }
      rerender({ guard: () => false });
      const previous = capture(result.current);
      const collector = jest.fn((state: TestState) => state);
      result.current.subscribe(collector, jest.fn());

      act(() => result.current.actions.history[operation]());

      expectUnchanged(result.current, previous);
      expect(collector).not.toHaveBeenCalled();
      rerender({ guard: () => true });
      act(() => result.current.actions.history[operation]());
      if (operation === 'clear') {
        expect(result.current.history.timeline).toHaveLength(0);
        expect(result.current.history.pointer).toBe(-1);
      } else {
        expect(result.current.query.getState().nodes.a.left).toBe(
          operation === 'undo' ? 0 : 10
        );
      }
    }
  );

  it('keeps the redo branch after a rejected write', () => {
    const { result, rerender } = renderStore();
    act(() => result.current.actions.setLeft('a', 10));
    act(() => result.current.actions.setLeft('a', 20));
    act(() => result.current.actions.history.undo());
    rerender({ guard: () => false });
    const previous = capture(result.current);

    act(() => result.current.actions.setLeft('b', 50));

    expectUnchanged(result.current, previous);
    expect(result.current.query.history.canRedo()).toBe(true);
    rerender({ guard: undefined });
    act(() => result.current.actions.history.redo());
    expect(result.current.query.getState().nodes.a.left).toBe(20);
    expect(result.current.query.getState().nodes.b.left).toBe(0);
  });

  it('uses the latest validator even through an action reference from an earlier render', () => {
    const first = jest.fn(() => false);
    const second = jest.fn(() => true);
    const { result, rerender } = renderStore(first);
    const setLeft = result.current.actions.setLeft;

    act(() => setLeft('a', 10));
    expect(result.current.query.getState().nodes.a.left).toBe(0);
    rerender({ guard: second });
    act(() => setLeft('a', 20));
    expect(result.current.query.getState().nodes.a.left).toBe(20);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    rerender({ guard: undefined });
    act(() => setLeft('a', 30));
    expect(result.current.query.getState().nodes.a.left).toBe(30);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it.each(['write', 'undo', 'redo', 'clear'] as const)(
    'rolls back %s when validation throws',
    (operation) => {
      const { result, rerender } = renderStore();
      act(() => result.current.actions.setLeft('a', 10));
      if (operation === 'redo') {
        act(() => result.current.actions.history.undo());
      }
      rerender({
        guard: () => {
          throw new Error('validation failed');
        },
      });
      const previous = capture(result.current);

      expect(() => {
        act(() => {
          if (operation === 'write') {
            result.current.actions.setLeft('a', 20);
          } else {
            result.current.actions.history[operation]();
          }
        });
      }).toThrow('validation failed');

      expectUnchanged(result.current, previous);
    }
  );

  it.each([
    ['Promise', () => Promise.resolve(false)],
    ['thenable', () => ({ then: () => {} })],
  ])(
    'rejects a %s result instead of silently allowing an async guard',
    (_name, guard) => {
      const { result, rerender } = renderStore();
      act(() => result.current.actions.setLeft('a', 10));
      rerender({ guard: (guard as unknown) as Guard });
      const previous = capture(result.current);

      expect(() => {
        act(() => result.current.actions.history.undo());
      }).toThrow('validateChange must be synchronous');

      expectUnchanged(result.current, previous);
    }
  );
});
