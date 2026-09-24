import { SystemEditChange } from './editTransaction';
import { Node, NodeId } from './nodes';

export type EditorLock = '' | 'position' | 'all';

export type EditOperation =
  | 'select'
  | 'props'
  | 'geometry'
  | 'structure'
  | 'lock';

export type EditAccessResult = {
  allowed: boolean;
  reason?: string;
  lockOwnerId?: NodeId;
};

export type EditAccessOptions = {
  operation: EditOperation;
  selectionSource?: 'canvas' | 'layer';
};

export type EditAccessPolicy = {
  /** An application-owned document identity or revision for delayed edits. */
  documentRevision?: string | number;
  /** Editable subtrees. Omit to allow the entire document; [] allows none. */
  scope?: readonly NodeId[];
  /** Defaults to the node's custom.editorLock value. */
  getLock?: (node: Node) => EditorLock;
  /** Paths are relative to node.data.props. */
  isGeometryProp?: (path: readonly (string | number)[], node: Node) => boolean;
  /** Explicitly authorize the actual patches of derived/runtime transactions. */
  canApplySystemChange?: (change: SystemEditChange) => boolean;
};
