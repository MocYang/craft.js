import {
  EditAccessPolicy,
  EditOperation,
  EditorState,
  Node,
} from '../../interfaces';
import { createNode } from '../../utils/createNode';
import { NodeHelpers } from '../NodeHelpers';
import {
  getEditAccess,
  getEditorLock,
  isGeometryProp,
} from '../editAccess/permissions';
import { editorInitialState } from '../store';

function makeState(policy: boolean | EditAccessPolicy = true): EditorState {
  const root = createNode({
    id: 'ROOT',
    data: { type: 'div', nodes: ['parent', 'outside'] },
  });
  const parent = createNode({
    id: 'parent',
    data: {
      type: 'div',
      parent: 'ROOT',
      nodes: ['child'],
      linkedNodes: { content: 'linked' },
    },
  });
  const child = createNode({
    id: 'child',
    data: { type: 'div', parent: 'parent' },
  });
  const linked = createNode({
    id: 'linked',
    data: { type: 'div', parent: 'parent' },
  });
  const outside = createNode({
    id: 'outside',
    data: { type: 'div', parent: 'ROOT' },
  });
  return {
    ...editorInitialState,
    nodes: { ROOT: root, parent, child, linked, outside },
    options: { ...editorInitialState.options, editAccess: policy },
  };
}

describe('edit access permissions', () => {
  let state: EditorState;

  beforeEach(() => {
    state = makeState();
  });

  function access(id: string, operation: EditOperation) {
    return getEditAccess(state, id, { operation });
  }

  it.each([false, undefined])(
    'keeps legacy access when the policy is %s',
    (policy) => {
      state.options.editAccess = policy;
      state.options.enabled = false;
      state.nodes.child.data.custom.editorLock = 'all';
      expect(access('child', 'geometry')).toEqual({ allowed: true });
      expect(access('ROOT', 'lock')).toEqual({ allowed: true });
    }
  );

  it('reports missing nodes through the public node helper', () => {
    expect(
      NodeHelpers(state, 'missing').getEditAccess({ operation: 'props' })
    ).toEqual({ allowed: false, reason: 'node-not-found' });
    expect(
      NodeHelpers(state, 'child').getEditAccess({ operation: 'props' })
    ).toEqual({ allowed: true });
  });

  it.each<EditOperation>(['props', 'geometry', 'structure', 'lock', 'select'])(
    'rejects %s when the editor is disabled',
    (operation) => {
      state.options.enabled = false;
      expect(access('child', operation)).toEqual({
        allowed: false,
        reason: 'editor-disabled',
      });
    }
  );

  it('allows layer inspection outside the scope with disabled editing', () => {
    state.options.enabled = false;
    state.options.editAccess = { scope: ['outside'] };
    state.nodes.child.data.custom.editorLock = 'all';
    expect(
      getEditAccess(state, 'child', {
        operation: 'select',
        selectionSource: 'layer',
      })
    ).toEqual({ allowed: true });
  });

  it('allows position-locked content and selection, but protects geometry', () => {
    state.nodes.parent.data.custom.editorLock = 'position';
    expect(access('parent', 'props').allowed).toBe(true);
    expect(access('child', 'props').allowed).toBe(true);
    expect(access('child', 'select').allowed).toBe(true);
    expect(access('child', 'geometry')).toEqual({
      allowed: false,
      reason: 'ancestor-locked',
      lockOwnerId: 'parent',
    });
    expect(access('parent', 'structure')).toEqual({
      allowed: false,
      reason: 'node-locked',
      lockOwnerId: 'parent',
    });
  });

  it.each<EditOperation>(['props', 'geometry', 'structure', 'select'])(
    'inherits an all lock for %s through linked nodes',
    (operation) => {
      state.nodes.parent.data.custom.editorLock = 'all';
      expect(access('linked', operation)).toEqual({
        allowed: false,
        reason: 'ancestor-locked',
        lockOwnerId: 'parent',
      });
    }
  );

  it('permits unlocking a node itself, but not a locked ancestor', () => {
    state.nodes.child.data.custom.editorLock = 'all';
    expect(access('child', 'lock').allowed).toBe(true);
    state.nodes.parent.data.custom.editorLock = 'position';
    expect(access('child', 'lock')).toEqual({
      allowed: false,
      reason: 'ancestor-locked',
      lockOwnerId: 'parent',
    });
    expect(access('parent', 'lock').allowed).toBe(true);
  });

  it('does not allow locking the root', () => {
    expect(access('ROOT', 'lock')).toEqual({
      allowed: false,
      reason: 'root-lock',
    });
  });

  it.each(['child', 'linked'])(
    'protects the locked descendant %s from ancestor transforms and changes',
    (id) => {
      state.nodes[id].data.custom.editorLock = 'position';
      for (const operation of ['geometry', 'structure'] as const) {
        expect(access('parent', operation)).toEqual({
          allowed: false,
          reason: 'descendant-locked',
          lockOwnerId: id,
        });
      }
      expect(access('parent', 'props').allowed).toBe(true);
      expect(access('outside', 'geometry').allowed).toBe(true);
    }
  );

  it('allows the scope subtree but rejects its ancestors and siblings', () => {
    state.options.editAccess = { scope: ['parent'] };
    for (const id of ['parent', 'child', 'linked']) {
      expect(access(id, 'props').allowed).toBe(true);
    }
    for (const id of ['ROOT', 'outside']) {
      expect(access(id, 'props')).toEqual({
        allowed: false,
        reason: 'outside-scope',
      });
      expect(access(id, 'select').allowed).toBe(false);
    }
  });

  it('treats an empty scope as no editable nodes', () => {
    state.options.editAccess = { scope: [] };
    expect(access('child', 'props').reason).toBe('outside-scope');
  });

  it('does not ignore ancestor locks when a scope starts below them', () => {
    state.options.editAccess = { scope: ['child'] };
    state.nodes.parent.data.custom.editorLock = 'all';
    expect(access('child', 'props').lockOwnerId).toBe('parent');
  });

  it('rejects inconsistent node identities instead of matching a false scope', () => {
    state.options.editAccess = { scope: ['parent'] };
    state.nodes.outside.id = 'parent';
    expect(access('outside', 'props')).toEqual({
      allowed: false,
      reason: 'invalid-tree',
    });
  });

  it('accepts an application lock reader without modifying serialized custom', () => {
    state.options.editAccess = {
      getLock: (node) => (node.id === 'parent' ? 'all' : ''),
    };
    expect(access('child', 'props').lockOwnerId).toBe('parent');
    expect(state.nodes.parent.data.custom).toEqual({});
  });

  it.each(['missing-parent', 'cycle'])(
    'fails closed for an invalid ancestor chain: %s',
    (kind) => {
      state.nodes.parent.data.parent = kind === 'cycle' ? 'child' : 'missing';
      expect(access('child', 'props')).toEqual({
        allowed: false,
        reason: 'invalid-tree',
      });
      expect(
        getEditAccess(state, 'child', {
          operation: 'select',
          selectionSource: 'layer',
        }).allowed
      ).toBe(true);
    }
  );

  it.each(['missing', 'cycle', 'linked-cycle'])(
    'fails closed for invalid descendant traversal: %s',
    (kind) => {
      if (kind === 'missing') {
        state.nodes.child.data.nodes = ['missing'];
      } else if (kind === 'cycle') {
        state.nodes.child.data.nodes = ['parent'];
      } else {
        state.nodes.linked.data.linkedNodes = { cycle: 'parent' };
      }
      expect(access('parent', 'structure')).toEqual({
        allowed: false,
        reason: 'invalid-tree',
      });
    }
  );
});

describe('default edit access fields', () => {
  let node: Node;

  beforeEach(() => {
    node = makeState().nodes.child;
  });

  it.each(['position', 'all', '', undefined, true, 'unexpected'])(
    'normalizes the persisted lock value %s',
    (value) => {
      node.data.custom.editorLock = value;
      expect(getEditorLock(node)).toBe(
        value === 'position' || value === 'all' ? value : ''
      );
    }
  );

  it.each([
    ['style'],
    ['style', 'width'],
    ['style', 'translateX'],
    ['style', 'marginTop'],
    ['style', 'gridTemplateColumns'],
    ['style', 'min-width'],
  ])('recognizes geometry at %s', (...path) => {
    expect(isGeometryProp(path, node)).toBe(true);
  });

  it.each([
    ['style', 'color'],
    ['option', 'graphic', 'style', 'width'],
    ['points'],
    ['events', 'style', 'width'],
    ['dataBinding', 'width'],
  ])('does not interpret business data at %s as node geometry', (...path) => {
    expect(isGeometryProp(path, node)).toBe(false);
  });

  it('supports an application geometry classifier', () => {
    const policy: EditAccessPolicy = {
      isGeometryProp: (path, target) =>
        target.id === node.id &&
        (path[0] === 'points' || isGeometryProp(path, target)),
    };
    expect(isGeometryProp(['points', 0, 'x'], node, policy)).toBe(true);
    expect(isGeometryProp(['style', 'width'], node, policy)).toBe(true);
    expect(isGeometryProp(['option', 'width'], node, policy)).toBe(false);
  });

  it('rejects an asynchronous lock reader instead of treating it as unlocked', () => {
    const policy: EditAccessPolicy = {
      // JavaScript consumers may supply an async hook despite this contract.
      // @ts-expect-error Lock readers must be synchronous.
      getLock: async () => 'all',
    };
    expect(() => getEditorLock(node, policy)).toThrow(/synchronous/i);
  });

  it('rejects asynchronous geometry classifiers', () => {
    const policy: EditAccessPolicy = {
      // @ts-expect-error Geometry classifiers must be synchronous.
      isGeometryProp: async () => false,
    };
    expect(() => isGeometryProp(['style', 'width'], node, policy)).toThrow(
      /synchronous/i
    );
  });

  it('rejects custom thenables as well as native promises', () => {
    const policy: EditAccessPolicy = {
      // @ts-expect-error A thenable is not a synchronous lock value.
      getLock: () => ({ then: () => {} }),
    };
    expect(() => getEditorLock(node, policy)).toThrow(/synchronous/i);
  });
});
