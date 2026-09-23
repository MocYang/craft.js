import { act, renderHook } from '@testing-library/react';

import { useEditorStore } from '../../editor/store';
import { EditAccessPolicy, EditorLock, Indicator } from '../../interfaces';
import { createNode } from '../../utils/createNode';
import { DefaultEventHandlers } from '../DefaultEventHandlers';

function setup(
  lock: EditorLock = '',
  policy: boolean | EditAccessPolicy = true
) {
  const { result } = renderHook(() =>
    useEditorStore({ editAccess: policy }, () => {})
  );
  const store = result.current;
  const nodes = Object.fromEntries(
    ['ROOT', 'first', 'second'].map((id) => [
      id,
      createNode({
        id,
        data: {
          type: 'div',
          isCanvas: true,
          parent: id === 'ROOT' ? null : 'ROOT',
          nodes: id === 'ROOT' ? ['first', 'second'] : [],
          custom: id === 'first' ? { editorLock: lock } : {},
        },
      }),
    ])
  );
  for (const node of Object.values(nodes))
    node.dom = document.createElement('div');
  act(() =>
    store.actions.transact({ source: 'document-load' }, (tx) =>
      tx.replaceNodes(nodes)
    )
  );
  const handler = new DefaultEventHandlers({
    store,
    isMultiSelectEnabled: (e) => e.shiftKey,
    removeHoverOnMouseleave: true,
  });
  return { store, handler, el: nodes.first.dom };
}

function dispatch(el: HTMLElement, name: string, shiftKey = false) {
  const event = new MouseEvent(name, {
    bubbles: true,
    cancelable: true,
    shiftKey,
  });
  Object.defineProperty(event, 'dataTransfer', {
    value: { setDragImage: jest.fn() },
  });
  act(() => {
    el.dispatchEvent(event);
  });
  return event;
}

describe('canvas edit access', () => {
  it('blocks full-lock canvas selection and hover while keeping layer selection available', () => {
    const { store, handler, el } = setup('all');
    const select = handler.handlers().select(el, 'first');
    const hover = handler.handlers().hover(el, 'first');
    dispatch(el, 'mousedown');
    dispatch(el, 'click');
    dispatch(el, 'mouseover');
    expect(store.query.getEvent('selected').all()).toEqual([]);
    expect(store.query.getEvent('hovered').all()).toEqual([]);
    act(() => store.actions.selectNode('first'));
    expect(store.query.getEvent('selected').all()).toEqual(['first']);
    select();
    hover();
  });

  it('allows position-lock selection and reacts to unlock without reconnecting drag listeners', () => {
    const { store, handler, el } = setup('position');
    const select = handler.handlers().select(el, 'first');
    const drag = handler.handlers().drag(el, 'first');
    dispatch(el, 'mousedown');
    expect(store.query.getEvent('selected').all()).toEqual(['first']);
    expect(dispatch(el, 'dragstart').defaultPrevented).toBe(true);
    expect(handler.positioner).toBeNull();
    act(() => store.actions.setEditorLock('first', ''));
    expect(dispatch(el, 'dragstart').defaultPrevented).toBe(false);
    expect(handler.positioner).not.toBeNull();
    dispatch(el, 'dragend');
    expect(handler.positioner).toBeNull();
    expect(document.querySelector('.drag-shadow')).toBeNull();
    select();
    drag();
  });

  it('uses the current isolation scope without reconnecting selection listeners', () => {
    const { store, handler, el } = setup('', { scope: ['second'] });
    const cleanup = handler.handlers().select(el, 'first');
    dispatch(el, 'mousedown');
    expect(store.query.getEvent('selected').all()).toEqual([]);
    act(() =>
      store.actions.setOptions((options) => {
        options.editAccess = { scope: ['first'] };
      })
    );
    dispatch(el, 'mousedown');
    expect(store.query.getEvent('selected').all()).toEqual(['first']);
    cleanup();
  });

  it('rejects the entire drag selection when one member is locked', () => {
    const { store, handler } = setup('position');
    const el = store.query.node('second').get().dom;
    const cleanup = handler.handlers().drag(el, 'second');
    act(() => store.actions.selectNode(['first', 'second']));
    handler.currentSelectedElementIds = ['first', 'second'];
    expect(dispatch(el, 'dragstart', true).defaultPrevented).toBe(true);
    expect(store.query.getEvent('dragged').all()).toEqual([]);
    expect(handler.positioner).toBeNull();
    cleanup();
  });

  it('rechecks access at drop time and still cleans up the drag', () => {
    const { store, handler, el } = setup();
    const cleanup = handler.handlers().drag(el, 'first');
    dispatch(el, 'dragstart');
    const indicator: Indicator = {
      error: null,
      placement: {
        parent: store.query.node('ROOT').get(),
        index: 1,
        where: 'after',
        currentNode: null,
      },
    };
    jest.spyOn(handler.positioner, 'getIndicator').mockReturnValue(indicator);
    const clearPositioner = jest.spyOn(handler.positioner, 'cleanup');
    act(() => store.actions.setEditorLock('first', 'position'));
    dispatch(el, 'dragend');
    expect(store.query.node('ROOT').get().data.nodes).toEqual([
      'first',
      'second',
    ]);
    expect(clearPositioner).toHaveBeenCalled();
    expect(handler.positioner).toBeNull();
    expect(store.query.getEvent('dragged').all()).toEqual([]);
    expect(document.querySelector('.drag-shadow')).toBeNull();
    cleanup();
  });

  it('preserves legacy canvas selection with editAccess disabled', () => {
    const { store, handler, el } = setup('all', false);
    const cleanup = handler.handlers().select(el, 'first');
    dispatch(el, 'mousedown');
    expect(store.query.getEvent('selected').all()).toEqual(['first']);
    cleanup();
  });
});
