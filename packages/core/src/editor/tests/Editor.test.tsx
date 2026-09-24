import { render, act } from '@testing-library/react';
import React from 'react';

import { useEditor } from '../../hooks/useEditor';
import { Editor } from '../Editor';

/**
 * Grabs the store handles out of the Editor context so the test can dispatch
 * real actions and observe what the internal subscriptions do.
 * `store.actions` is exposed too: setNodeEvent / setDOM are stripped from the
 * public `actions`, but they're exactly the dispatches we need to exercise.
 */
const CaptureStore = ({ onReady }: { onReady: (editor: any) => void }) => {
  const { actions, query, store } = useEditor();

  React.useEffect(() => {
    onReady({ actions, query, store });
  }, [actions, query, store, onReady]);

  return null;
};

const renderEditor = (props: Record<string, any> = {}) => {
  let editor: any = null;

  render(
    <Editor {...props}>
      <CaptureStore
        onReady={(value) => {
          editor = value;
        }}
      />
    </Editor>
  );

  return () => editor;
};

// Smallest useful tree: ROOT (canvas) > CHILD
const serializedTree = JSON.stringify({
  ROOT: {
    type: 'div',
    isCanvas: true,
    props: { title: 'root' },
    displayName: 'div',
    custom: {},
    hidden: false,
    nodes: ['CHILD'],
    linkedNodes: {},
    parent: null,
  },
  CHILD: {
    type: 'span',
    isCanvas: false,
    props: { title: 'child' },
    displayName: 'span',
    custom: {},
    hidden: false,
    nodes: [],
    linkedNodes: {},
    parent: 'ROOT',
  },
});

/**
 * Renders an Editor that already holds a small tree, then clears the mock so
 * each test only sees the calls caused by the dispatch under test.
 */
const setupWithTree = () => {
  const onNodesChange = jest.fn();
  const getEditor = renderEditor({ onNodesChange });
  const editor = getEditor();

  act(() => {
    editor.actions.deserialize(serializedTree);
  });
  onNodesChange.mockClear();

  return { editor, onNodesChange };
};

describe('<Editor /> onNodesChange subscription', () => {
  it('should not serialize the tree on every dispatch', () => {
    const { editor } = setupWithTree();
    const serialize = jest.spyOn(editor.query, 'serialize');

    act(() => {
      editor.actions.setProp('CHILD', (props) => {
        props.title = 'changed';
      });
    });
    act(() => {
      editor.store.actions.setNodeEvent('hovered', ['CHILD']);
    });

    // The collector must stay cheap. Serializing belongs in the consumer's
    // callback, where it can be debounced — not in the subscription's collector.
    expect(serialize).not.toHaveBeenCalled();
  });

  it('should notify on the first change after subscribing', () => {
    const onNodesChange = jest.fn();
    const getEditor = renderEditor({ onNodesChange });

    act(() => {
      getEditor().actions.deserialize(serializedTree);
    });

    // Consumers (eg: dirty tracking) record their baseline on this first call
    expect(onNodesChange).toHaveBeenCalledTimes(1);
    expect(typeof onNodesChange.mock.calls[0][0].serialize).toBe('function');
  });

  describe('should NOT notify when node data is untouched', () => {
    it('hover', () => {
      const { editor, onNodesChange } = setupWithTree();

      act(() => {
        editor.store.actions.setNodeEvent('hovered', ['CHILD']);
      });
      act(() => {
        editor.store.actions.setNodeEvent('hovered', null);
      });

      expect(onNodesChange).not.toHaveBeenCalled();
    });

    it('select', () => {
      const { editor, onNodesChange } = setupWithTree();

      act(() => {
        editor.actions.selectNode('CHILD');
      });
      act(() => {
        editor.actions.clearEvents();
      });

      expect(onNodesChange).not.toHaveBeenCalled();
    });

    it('setDOM', () => {
      const { editor, onNodesChange } = setupWithTree();

      act(() => {
        editor.store.actions.setDOM('CHILD', document.createElement('span'));
      });

      expect(onNodesChange).not.toHaveBeenCalled();
    });

    it('setOptions that leave the resolver alone', () => {
      const { editor, onNodesChange } = setupWithTree();

      act(() => {
        editor.actions.setOptions((options) => {
          options.enabled = !options.enabled;
        });
      });

      expect(onNodesChange).not.toHaveBeenCalled();
    });
  });

  describe('should notify when the serialized output can change', () => {
    it('setProp', () => {
      const { editor, onNodesChange } = setupWithTree();

      act(() => {
        editor.actions.setProp('CHILD', (props) => {
          props.title = 'changed';
        });
      });

      expect(onNodesChange).toHaveBeenCalledTimes(1);
    });

    it('setHidden', () => {
      const { editor, onNodesChange } = setupWithTree();

      act(() => {
        editor.actions.setHidden('CHILD', true);
      });

      expect(onNodesChange).toHaveBeenCalledTimes(1);
    });

    it('adding a node', () => {
      const { editor, onNodesChange } = setupWithTree();

      act(() => {
        const tree = editor.query.parseReactElement(<p />).toNodeTree();
        editor.actions.addNodeTree(tree, 'ROOT');
      });

      expect(onNodesChange).toHaveBeenCalledTimes(1);
    });

    it('deleting a node', () => {
      const { editor, onNodesChange } = setupWithTree();

      act(() => {
        editor.actions.delete('CHILD');
      });

      expect(onNodesChange).toHaveBeenCalledTimes(1);
    });

    it('undo / redo', () => {
      const { editor, onNodesChange } = setupWithTree();

      act(() => {
        editor.actions.setProp('CHILD', (props) => {
          props.title = 'changed';
        });
      });
      act(() => {
        editor.actions.history.undo();
      });
      act(() => {
        editor.actions.history.redo();
      });

      expect(onNodesChange).toHaveBeenCalledTimes(3);
    });

    it('changing the resolver', () => {
      const { editor, onNodesChange } = setupWithTree();

      act(() => {
        editor.actions.setOptions((options) => {
          options.resolver = { ...options.resolver };
        });
      });

      expect(onNodesChange).toHaveBeenCalledTimes(1);
    });
  });

  it('should not subscribe at all when onNodesChange is not supplied', () => {
    const getEditor = renderEditor();
    const editor = getEditor();

    const serialize = jest.spyOn(editor.query, 'serialize');

    expect(() =>
      act(() => {
        editor.actions.setOptions((options) => {
          options.enabled = !options.enabled;
        });
      })
    ).not.toThrow();
    expect(serialize).not.toHaveBeenCalled();
  });
});
