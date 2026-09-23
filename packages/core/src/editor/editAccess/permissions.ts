import { ROOT_NODE } from '@craftjs/utils';

import {
  EditAccessOptions,
  EditAccessPolicy,
  EditAccessResult,
  EditorLock,
  EditorState,
  Node,
  NodeId,
} from '../../interfaces';

const allowed: EditAccessResult = { allowed: true };

const geometryProperties = new Set([
  'position',
  'left',
  'right',
  'top',
  'bottom',
  'width',
  'height',
  'minWidth',
  'minHeight',
  'maxWidth',
  'maxHeight',
  'aspectRatio',
  'boxSizing',
  'display',
  'float',
  'clear',
  'transform',
  'transformOrigin',
  'transformBox',
  'translate',
  'translateX',
  'translateY',
  'rotate',
  'scale',
  'scaleX',
  'scaleY',
  'zoom',
  'zIndex',
  'order',
  'gap',
  'rowGap',
  'columnGap',
]);

function assertSynchronous(value: unknown): void {
  if (
    value &&
    (typeof value === 'object' || typeof value === 'function') &&
    'then' in value &&
    typeof value.then === 'function'
  ) {
    throw new Error('Edit access policies must return synchronously');
  }
}

export function getEditorLock(
  node: Node,
  policy: EditAccessPolicy = {}
): EditorLock {
  const value = policy.getLock
    ? policy.getLock(node)
    : node.data.custom?.editorLock;
  if (policy.getLock) {
    assertSynchronous(value);
  }
  return value === 'position' || value === 'all' ? value : '';
}

/** Classifies standard node style geometry; applications can extend this rule. */
export function isGeometryProp(
  path: readonly (string | number)[],
  node: Node,
  policy: EditAccessPolicy = {}
): boolean {
  if (policy.isGeometryProp) {
    const result = policy.isGeometryProp(path, node);
    assertSynchronous(result);
    return result;
  }
  if (path[0] !== 'style') {
    return false;
  }
  if (path.length === 1) {
    return true;
  }
  const property = String(path[1]).replace(/-([a-z])/g, (_, letter) =>
    letter.toUpperCase()
  );
  return (
    geometryProperties.has(property) ||
    /^(margin|padding|inset|flex|grid|align|justify|place|overflow)([A-Z]|$)/.test(
      property
    )
  );
}

function denied(reason: string, lockOwnerId?: NodeId): EditAccessResult {
  return lockOwnerId
    ? { allowed: false, reason, lockOwnerId }
    : { allowed: false, reason };
}

function getAncestors(state: EditorState, id: NodeId): Node[] | null {
  const ancestors: Node[] = [];
  const visited = new Set<NodeId>();
  let current = id;
  while (current) {
    const node = state.nodes[current];
    if (!node || node.id !== current || visited.has(current)) {
      return null;
    }
    visited.add(current);
    ancestors.push(node);
    current = node.data.parent;
  }
  return ancestors;
}

function checkDescendants(
  state: EditorState,
  id: NodeId,
  policy: EditAccessPolicy
): EditAccessResult {
  const visited = new Set<NodeId>([id]);
  const children = (node: Node) => [
    ...(node.data.nodes || []),
    ...Object.values(node.data.linkedNodes || {}),
  ];
  const pending = children(state.nodes[id]);
  while (pending.length) {
    const childId = pending.pop();
    const child = state.nodes[childId];
    if (!child || child.id !== childId || visited.has(childId)) {
      return denied('invalid-tree');
    }
    visited.add(childId);
    if (getEditorLock(child, policy)) {
      return denied('descendant-locked', childId);
    }
    pending.push(...children(child));
  }
  return allowed;
}

/** Returns edit permission without changing the document or editor session. */
export function getEditAccess(
  state: EditorState,
  id: NodeId,
  options: EditAccessOptions
): EditAccessResult {
  if (!state.nodes[id]) {
    return denied('node-not-found');
  }
  const configuredPolicy = state.options.editAccess;
  if (!configuredPolicy) {
    return allowed;
  }
  const policy = configuredPolicy === true ? {} : configuredPolicy;
  const { operation, selectionSource } = options;
  if (operation === 'select' && selectionSource === 'layer') {
    return allowed;
  }
  if (!state.options.enabled) {
    return denied('editor-disabled');
  }
  if (operation === 'lock' && id === ROOT_NODE) {
    return denied('root-lock');
  }
  const ancestors = getAncestors(state, id);
  if (!ancestors) {
    return denied('invalid-tree');
  }
  if (
    policy.scope &&
    !ancestors.some((ancestor) => policy.scope.includes(ancestor.id))
  ) {
    return denied('outside-scope');
  }
  for (const ancestor of ancestors) {
    const ownNode = ancestor.id === id;
    const lock = getEditorLock(ancestor, policy);
    if (!lock || (ownNode && operation === 'lock')) {
      continue;
    }
    if (
      lock === 'all' ||
      operation === 'geometry' ||
      operation === 'structure' ||
      operation === 'lock'
    ) {
      return denied(ownNode ? 'node-locked' : 'ancestor-locked', ancestor.id);
    }
  }
  return operation === 'geometry' || operation === 'structure'
    ? checkDescendants(state, id, policy)
    : allowed;
}
