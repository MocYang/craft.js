import { act, render } from '@testing-library/react';
import React, { useContext } from 'react';

import { Options } from '../../interfaces';
import { Element } from '../../nodes/Element';
import { Frame } from '../../render/Frame';
import { Editor } from '../Editor';
import { EditorContext } from '../EditorContext';
import { EditorStore } from '../store';

type PanelProps = {
  label?: string;
  showExtra?: boolean;
  style?: React.CSSProperties;
};

function Panel({ label, showExtra = false, style }: PanelProps) {
  return (
    <section data-testid="panel" style={style}>
      <span>{label}</span>
      <Element id="content" is="span" data-testid="linked-content">
        Linked content
      </Element>
      {showExtra && (
        <Element id="extra" is="span" data-testid="linked-extra">
          Extra content
        </Element>
      )}
    </section>
  );
}

const resolver = { Panel };

async function mountEditor(options: Partial<Options> = {}, data?: string) {
  let store: EditorStore;
  const CaptureStore = () => {
    store = useContext(EditorContext);
    return null;
  };
  const scene = (nextOptions: Partial<Options>) => (
    <Editor resolver={resolver} editAccess {...nextOptions}>
      <CaptureStore />
      <Frame data={data}>
        <Element canvas is="div">
          <Element
            is={Panel}
            custom={{ editorLock: 'position' }}
            label="initial"
            style={{ width: 100, color: 'black' }}
          />
        </Element>
      </Frame>
    </Editor>
  );
  const mounted = render(scene(options));
  await act(async () => {
    await Promise.resolve();
  });
  const panelId = Object.values(store.query.getNodes()).find(
    (node) => node.data.type === Panel
  ).id;
  return {
    ...mounted,
    store,
    panelId,
    rerenderOptions: (nextOptions: Partial<Options>) =>
      mounted.rerender(scene(nextOptions)),
  };
}

describe('edit access in the mounted Editor', () => {
  const consoleError = jest.spyOn(console, 'error');

  beforeEach(() => {
    consoleError.mockClear();
  });

  afterEach(() => {
    // Baseline cloneWithRef still reads element.ref, which React 19 warns about.
    // Keep every other runtime warning/error visible to this integration test.
    const baselineRefWarning =
      'Accessing element.ref was removed in React 19. ref is now a regular prop. It will be removed from the JSX Element type in a future release.';
    expect(
      consoleError.mock.calls.filter(
        ([message]) => message !== baselineRefWarning
      )
    ).toEqual([]);
  });

  it('initializes locked Frame JSX and component-owned linked nodes without history', async () => {
    const onEditDenied = jest.fn();
    const { store, panelId, getByTestId } = await mountEditor({ onEditDenied });
    const panel = store.query.node(panelId).get();
    const linkedId = panel.data.linkedNodes.content;

    expect(panel.data.custom.editorLock).toBe('position');
    expect(store.query.node(linkedId).get().data.parent).toBe(panelId);
    expect(
      store.query.node(linkedId).getEditAccess({ operation: 'geometry' })
    ).toMatchObject({ allowed: false, lockOwnerId: panelId });
    expect(getByTestId('linked-content').textContent).toBe('Linked content');
    expect(store.history.timeline).toHaveLength(0);
    expect(onEditDenied).not.toHaveBeenCalled();
  });

  it('loads serialized locks and linked nodes through Frame while editing is disabled', async () => {
    const original = await mountEditor();
    const data = original.store.query.serialize();
    original.unmount();
    const onEditDenied = jest.fn();
    const { store, panelId, getByTestId } = await mountEditor(
      { enabled: false, onEditDenied },
      data
    );

    expect(store.query.serialize()).toBe(data);
    expect(store.query.node(panelId).get().data.custom.editorLock).toBe(
      'position'
    );
    expect(getByTestId('linked-content')).toBeTruthy();
    expect(Object.keys(store.query.getNodes())).toHaveLength(3);
    expect(store.history.timeline).toHaveLength(0);
    expect(onEditDenied).not.toHaveBeenCalled();
  });

  it('applies updated editAccess props without remounting the document', async () => {
    const { store, panelId, rerenderOptions } = await mountEditor({
      editAccess: false,
    });
    act(() =>
      store.actions.setProp(panelId, (props) => {
        props.style.width = 150;
      })
    );
    expect(store.query.node(panelId).get().data.props.style.width).toBe(150);

    rerenderOptions({ editAccess: true });
    act(() =>
      store.actions.setProp(panelId, (props) => {
        props.style.width = 200;
      })
    );
    expect(store.query.node(panelId).get().data.props.style.width).toBe(150);

    rerenderOptions({ editAccess: { scope: [] } });
    act(() =>
      store.actions.setProp(panelId, (props) => {
        props.style.color = 'red';
      })
    );
    expect(store.query.node(panelId).get().data.props.style.color).toBe(
      'black'
    );

    rerenderOptions({ editAccess: { scope: [panelId] } });
    act(() =>
      store.actions.setProp(panelId, (props) => {
        props.style.color = 'red';
      })
    );
    expect(store.query.node(panelId).get().data.props.style.color).toBe('red');
    expect(Object.keys(store.query.getNodes())).toHaveLength(3);
  });

  it('initializes a dynamically rendered Element beneath an all-locked component', async () => {
    const onEditDenied = jest.fn();
    const { store, panelId, getByTestId } = await mountEditor({ onEditDenied });
    act(() => store.actions.setEditorLock(panelId, 'all'));
    await act(async () => {
      store.actions.transact({ source: 'document-load' }, (actions) => {
        actions.setProp(panelId, (props) => {
          props.showExtra = true;
        });
      });
    });

    const extraId = store.query.node(panelId).get().data.linkedNodes.extra;
    expect(store.query.node(extraId).get().data.parent).toBe(panelId);
    expect(getByTestId('linked-extra').textContent).toBe('Extra content');
    expect(
      store.query.node(extraId).getEditAccess({ operation: 'props' })
    ).toMatchObject({ allowed: false, lockOwnerId: panelId });
    expect(onEditDenied).not.toHaveBeenCalled();
  });

  it.each(['setProp', 'merged-transaction'])(
    'rejects normalized geometry as one change without notifying onNodesChange: %s',
    async (entry) => {
      const onNodesChange = jest.fn();
      const onEditDenied = jest.fn();
      const normalizeNodes = jest.fn<
        ReturnType<Options['normalizeNodes']>,
        Parameters<Options['normalizeNodes']>
      >((draft) => {
        const panel = Object.values(draft.nodes).find(
          (node) => node.data.type === Panel
        );
        if (panel?.data.props.label === 'normalize') {
          panel.data.props.style.width = 999;
        }
      });
      const { store, panelId } = await mountEditor({
        onNodesChange,
        onEditDenied,
        normalizeNodes,
      });
      const json = store.query.serialize();
      const history = [...store.history.timeline];
      onNodesChange.mockClear();
      normalizeNodes.mockClear();

      act(() => {
        if (entry === 'setProp') {
          store.actions.setProp(panelId, (props) => {
            props.label = 'normalize';
          });
        } else {
          store.actions.history.merge().transact({}, (actions) => {
            actions.setProp(panelId, (props) => {
              props.label = 'normalize';
            });
          });
        }
      });

      expect(normalizeNodes).toHaveBeenCalledTimes(1);
      expect(normalizeNodes.mock.calls[0][2].type).toBe(
        entry === 'setProp' ? 'setProp' : 'transact'
      );
      expect(store.query.serialize()).toBe(json);
      expect(store.history.timeline).toEqual(history);
      expect(onNodesChange).not.toHaveBeenCalled();
      expect(onEditDenied).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'node-locked',
          lockOwnerId: panelId,
        })
      );
    }
  );
});
