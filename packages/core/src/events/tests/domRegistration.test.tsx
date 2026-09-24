import { act, renderHook } from '@testing-library/react';

import { useEditorStore } from '../../editor/store';
import { createNode } from '../../utils/createNode';
import { DefaultEventHandlers } from '../DefaultEventHandlers';
import { queueDOMRegistration } from '../queueDOMRegistration';

function createStore(ids = ['child']) {
  const { result } = renderHook(() =>
    useEditorStore({ editAccess: true }, () => {})
  );
  const store = result.current;
  const nodes = Object.fromEntries(
    ['ROOT', ...ids].map((id) => [
      id,
      createNode({
        id,
        data: {
          type: 'div',
          isCanvas: true,
          parent: id === 'ROOT' ? null : 'ROOT',
          nodes: id === 'ROOT' ? ids : [],
        },
      }),
    ])
  );
  act(() => {
    store.actions.transact({ source: 'document-load' }, (tx) =>
      tx.replaceNodes(nodes)
    );
    store.actions.history.clear();
  });
  return store;
}

const flush = () =>
  act(async () => {
    await Promise.resolve();
  });

describe('DOM registration batches', () => {
  it('flushes 100 connector registrations as one store update without history', async () => {
    const ids = Array.from({ length: 100 }, (_, i) => `child-${i}`);
    const store = createStore(ids);
    const handler = new DefaultEventHandlers({
      store,
      isMultiSelectEnabled: () => false,
      removeHoverOnMouseleave: false,
    });
    const setDOM = jest.spyOn(store.actions, 'setDOM');
    const notified = jest.fn();
    store.subscribe((state) => state.nodes, notified);
    const elements = ids.map(() => document.createElement('div'));
    const cleanups = ids.map((id, i) =>
      handler.handlers().connect(elements[i], id)
    );
    expect(setDOM).not.toHaveBeenCalled();
    await flush();
    expect(setDOM).toHaveBeenCalledTimes(1);
    expect(notified).toHaveBeenCalledTimes(1);
    ids.forEach((id, i) =>
      expect(store.query.node(id).get().dom).toBe(elements[i])
    );
    expect(store.history.timeline).toHaveLength(0);
    cleanups.forEach((cleanup) => cleanup());
  });

  it('uses the last DOM registered for an id in a shared store batch', async () => {
    const store = createStore();
    const first = document.createElement('div');
    const last = document.createElement('div');
    queueDOMRegistration(store, 'child', first);
    queueDOMRegistration(store, 'child', last);
    await flush();
    expect(store.query.node('child').get().dom).toBe(last);
  });

  it('does not mix registrations between editor stores', async () => {
    const first = createStore();
    const second = createStore();
    const firstDOM = document.createElement('div');
    const secondDOM = document.createElement('div');
    queueDOMRegistration(first, 'child', firstDOM);
    queueDOMRegistration(second, 'child', secondDOM);
    await flush();
    expect(first.query.node('child').get().dom).toBe(firstDOM);
    expect(second.query.node('child').get().dom).toBe(secondDOM);
  });

  it('skips a node removed before its batch is flushed', async () => {
    const store = createStore();
    queueDOMRegistration(store, 'child', document.createElement('div'));
    act(() => store.actions.delete('child'));
    const historyLength = store.history.timeline.length;
    await flush();
    expect(store.query.node('child').get()).toBeUndefined();
    expect(store.history.timeline).toHaveLength(historyLength);
  });

  it('preserves new registrations queued by a subscriber during dispatch', async () => {
    const store = createStore();
    const first = document.createElement('div');
    const second = document.createElement('div');
    const notified = jest.fn((dom) => {
      if (dom === first) queueDOMRegistration(store, 'child', second);
    });
    store.subscribe((state) => state.nodes.child.dom, notified);
    const setDOM = jest.spyOn(store.actions, 'setDOM');
    queueDOMRegistration(store, 'child', first);
    await flush();
    expect(setDOM).toHaveBeenCalledTimes(2);
    expect(notified).toHaveBeenCalledTimes(2);
    expect(store.query.node('child').get().dom).toBe(second);
  });

  it('keeps single writes synchronous and accepts locked readonly DOM batches', () => {
    const store = createStore();
    const first = document.createElement('div');
    act(() => store.actions.setDOM('child', first));
    expect(store.query.node('child').get().dom).toBe(first);
    act(() => {
      store.actions.setEditorLock('child', 'all');
      store.actions.setOptions((options) => {
        options.enabled = false;
      });
    });
    const historyLength = store.history.timeline.length;
    const last = document.createElement('div');
    act(() =>
      store.actions.setDOM([
        ['missing', first],
        ['child', last],
      ])
    );
    expect(store.query.node('child').get().dom).toBe(last);
    expect(store.query.node('missing').get()).toBeUndefined();
    expect(store.history.timeline).toHaveLength(historyLength);
  });
});
