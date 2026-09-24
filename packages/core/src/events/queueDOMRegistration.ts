import { EditorStore } from '../editor/store';
import { NodeId } from '../interfaces';

// Share a batch across handlers for the same store, without serializing the queue.
const pending = new WeakMap<EditorStore, Map<NodeId, HTMLElement>>();

export function queueDOMRegistration(
  store: EditorStore,
  id: NodeId,
  dom: HTMLElement
) {
  const existing = pending.get(store);
  if (existing) {
    existing.set(id, dom);
    return;
  }

  const batch = new Map([[id, dom]]);
  pending.set(store, batch);
  queueMicrotask(() => {
    // Detach before dispatch: a subscriber can enqueue the next batch.
    pending.delete(store);
    store.actions.setDOM(Array.from(batch));
  });
}
