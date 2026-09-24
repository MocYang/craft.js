import { act, renderHook } from '@testing-library/react';

import { useCollector } from '../useCollector';
import { useMethods } from '../useMethods';

const methods = (state) => ({
  setValue(key, value) {
    state[key] = value;
  },
  setNodeValue(id, value) {
    state.nodes[id].data.props.value = value;
  },
});

describe('useMethods subscriptions', () => {
  it('notifies only subscribers whose dependency path intersects the patch', () => {
    const { result } = renderHook(() =>
      useMethods(methods, {
        nodes: {
          a: { data: { props: { value: 1 } } },
          b: { data: { props: { value: 1 } } },
        },
        events: { selected: null },
      })
    );
    const nodeA = jest.fn();
    const nodeB = jest.fn();
    const nodes = jest.fn();
    const selected = jest.fn();
    const legacy = jest.fn();

    result.current.subscribe(
      (state) => state.nodes.a.data.props.value,
      nodeA,
      false,
      { dependencies: [['nodes', 'a', 'data', 'props', 'value']] }
    );
    result.current.subscribe(
      (state) => state.nodes.b.data.props.value,
      nodeB,
      false,
      { dependencies: [['nodes', 'b']] }
    );
    result.current.subscribe((state) => state.nodes, nodes, false, {
      dependencies: [['nodes']],
    });
    result.current.subscribe(
      (state) => state.events.selected,
      selected,
      false,
      { dependencies: [['events', 'selected']] }
    );
    result.current.subscribe((state) => state, legacy);

    act(() => {
      result.current.actions.setNodeValue('a', 2);
    });

    expect(nodeA).toHaveBeenCalledTimes(1);
    expect(nodeB).not.toHaveBeenCalled();
    expect(nodes).toHaveBeenCalledTimes(1);
    expect(selected).not.toHaveBeenCalled();
    expect(legacy).toHaveBeenCalledTimes(1);
  });

  it('does not fire onChange on the first notify when seeded with initialCollected', () => {
    const { result } = renderHook(() =>
      useMethods(methods, { value: 1, other: 1 })
    );
    const seeded = jest.fn();
    const unseeded = jest.fn();

    // A subscriber whose baseline is already known must stay quiet when the
    // collected value hasn't actually changed.
    result.current.subscribe((state) => state.value, seeded, false, {
      initialCollected: 1,
    });
    // Without the seed, the first notify compares against undefined and fires.
    result.current.subscribe((state) => state.value, unseeded);

    act(() => {
      result.current.actions.setValue('other', 2);
    });

    expect(seeded).not.toHaveBeenCalled();
    expect(unseeded).toHaveBeenCalledTimes(1);
  });

  it('still fires onChange when the seeded value genuinely changes', () => {
    const { result } = renderHook(() => useMethods(methods, { value: 1 }));
    const subscriber = jest.fn();

    result.current.subscribe((state) => state.value, subscriber, false, {
      initialCollected: 1,
    });

    act(() => {
      result.current.actions.setValue('value', 2);
    });

    expect(subscriber).toHaveBeenCalledTimes(1);
    expect(subscriber).toHaveBeenCalledWith(2);
  });

  it('does not notify subscribers when an action leaves state unchanged', () => {
    const { result } = renderHook(() => useMethods(methods, { value: 1 }));
    const subscriber = jest.fn();

    result.current.subscribe((state) => state.value, subscriber);

    act(() => {
      result.current.actions.setValue('value', 1);
    });

    expect(subscriber).not.toHaveBeenCalled();
  });

  it('collects descendant subscriptions when a parent path is replaced', () => {
    const { result } = renderHook(() =>
      useMethods(methods, {
        nodes: {
          a: { data: { props: { value: 1 } } },
          b: { data: { props: { value: 1 } } },
        },
      })
    );
    const collectNodeA = jest.fn((state) => state.nodes.a);
    const collectNodeB = jest.fn((state) => state.nodes.b);

    result.current.subscribe(collectNodeA, jest.fn(), false, {
      dependencies: [['nodes', 'a']],
    });
    result.current.subscribe(collectNodeB, jest.fn(), false, {
      dependencies: [['nodes', 'b']],
    });

    act(() => {
      result.current.actions.setValue('nodes', {
        ...(result.current.getState() as any).nodes,
        a: { data: { props: { value: 2 } } },
      });
    });

    expect(collectNodeA).toHaveBeenCalledTimes(1);
    expect(collectNodeB).toHaveBeenCalledTimes(1);
  });

  it('refreshes the collected baseline when dependency paths change', () => {
    const { result, rerender } = renderHook(
      ({ id }) => {
        const store = useMethods(methods, {
          nodes: {
            a: { data: { props: { value: 1 } } },
            b: { data: { props: { value: 2 } } },
          },
        });

        return useCollector(
          store,
          (state) => ({ value: state.nodes[id].data.props.value }),
          { dependencies: [['nodes', id]] }
        );
      },
      { initialProps: { id: 'a' } }
    );

    expect(result.current.value).toBe(1);

    act(() => {
      rerender({ id: 'b' });
    });

    expect(result.current.value).toBe(2);
  });
});
