import { act, render } from '@testing-library/react';
import React, { useContext } from 'react';

import { createNode } from '../../utils/createNode';
import { Editor } from '../Editor';
import { EditorContext } from '../EditorContext';
import { editorInitialState, EditorStore } from '../store';

describe('Editor node change notifications', () => {
  let store: EditorStore;

  const CaptureStore = () => {
    store = useContext(EditorContext);
    return null;
  };

  const changeNode = (title: string) => {
    act(() => {
      store.actions.setState((state) => {
        state.nodes.test = createNode({
          id: 'test',
          data: { type: 'div', props: { title } },
        });
      });
    });
  };

  it('does not serialize nodes when no callback is configured', () => {
    render(
      <Editor>
        <CaptureStore />
      </Editor>
    );
    const serialize = jest.spyOn(store.query, 'serialize');

    changeNode('one');
    act(() =>
      store.actions.setOptions((options) => {
        options.enabled = false;
      })
    );

    expect(serialize).not.toHaveBeenCalled();
  });

  it('notifies every accepted store update without serializing nodes', () => {
    const onNodesChange = jest.fn();
    render(
      <Editor onNodesChange={onNodesChange}>
        <CaptureStore />
      </Editor>
    );
    const serialize = jest.spyOn(store.query, 'serialize');

    changeNode('one');
    expect(onNodesChange).toHaveBeenCalledTimes(1);
    expect(onNodesChange).toHaveBeenCalledWith(store.query);

    act(() =>
      store.actions.setOptions((options) => {
        options.indicator.success = 'magenta';
      })
    );
    expect(onNodesChange).toHaveBeenCalledTimes(2);
    act(() => store.actions.setDOM('test', document.createElement('div')));
    act(() => store.actions.selectNode('test'));
    expect(onNodesChange).toHaveBeenCalledTimes(4);
    expect(serialize).not.toHaveBeenCalled();
  });

  it('supports a callback added after mounting through setOptions', () => {
    const onNodesChange = jest.fn();
    render(
      <Editor>
        <CaptureStore />
      </Editor>
    );
    changeNode('one');

    act(() =>
      store.actions.setOptions((options) => {
        options.onNodesChange = onNodesChange;
      })
    );
    onNodesChange.mockClear();
    changeNode('two');

    expect(onNodesChange).toHaveBeenCalledTimes(1);
    expect(onNodesChange).toHaveBeenCalledWith(store.query);
  });

  it('stops serializing when the default callback is restored', () => {
    const onNodesChange = jest.fn();
    render(
      <Editor onNodesChange={onNodesChange}>
        <CaptureStore />
      </Editor>
    );
    changeNode('one');

    act(() =>
      store.actions.setOptions((options) => {
        options.onNodesChange = editorInitialState.options.onNodesChange;
      })
    );
    const serialize = jest.spyOn(store.query, 'serialize');
    onNodesChange.mockClear();
    changeNode('two');

    expect(serialize).not.toHaveBeenCalled();
    expect(onNodesChange).not.toHaveBeenCalled();
  });

  it('uses the latest callback after setOptions replaces it', () => {
    const original = jest.fn();
    const replacement = jest.fn();
    render(
      <Editor onNodesChange={original}>
        <CaptureStore />
      </Editor>
    );
    changeNode('one');
    original.mockClear();

    act(() =>
      store.actions.setOptions((options) => {
        options.onNodesChange = replacement;
      })
    );
    changeNode('two');

    expect(original).not.toHaveBeenCalled();
    // Replacing options is itself a store notification, followed by the edit.
    expect(replacement).toHaveBeenCalledTimes(2);
  });

  it('cleans up subscriptions across StrictMode remounts and unmount', () => {
    const onNodesChange = jest.fn();
    const { unmount } = render(
      <React.StrictMode>
        <Editor onNodesChange={onNodesChange}>
          <CaptureStore />
        </Editor>
      </React.StrictMode>
    );
    onNodesChange.mockClear();
    changeNode('one');
    expect(onNodesChange).toHaveBeenCalledTimes(1);

    unmount();
    onNodesChange.mockClear();
    const serialize = jest.spyOn(store.query, 'serialize');
    changeNode('two');

    expect(serialize).not.toHaveBeenCalled();
    expect(onNodesChange).not.toHaveBeenCalled();
  });
});
