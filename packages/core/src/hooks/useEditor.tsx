import {
  Overwrite,
  Delete,
  OverwriteFnReturnType,
  SubscribeOptions,
} from '@craftjs/utils';
import { useMemo } from 'react';

import {
  useInternalEditor,
  EditorCollector,
  useInternalEditorReturnType,
} from '../editor/useInternalEditor';

type PrivateActions =
  | 'addLinkedNodeFromTree'
  | 'setNodeEvent'
  | 'setDOM'
  | 'replaceNodes'
  | 'reset';

const getPublicActions = (actions) => {
  const {
    addLinkedNodeFromTree,
    setDOM,
    setNodeEvent,
    replaceNodes,
    reset,
    ...EditorActions
  } = actions;

  return EditorActions;
};

export type WithoutPrivateActions<S = null> = Delete<
  useInternalEditorReturnType<S>['actions'],
  PrivateActions | 'history'
> & {
  history: Overwrite<
    useInternalEditorReturnType<S>['actions']['history'],
    {
      ignore: OverwriteFnReturnType<
        useInternalEditorReturnType<S>['actions']['history']['ignore'],
        PrivateActions
      >;
      throttle: OverwriteFnReturnType<
        useInternalEditorReturnType<S>['actions']['history']['throttle'],
        PrivateActions
      >;
    }
  >;
};

export type useEditorReturnType<S = null> = Overwrite<
  useInternalEditorReturnType<S>,
  {
    actions: WithoutPrivateActions;
    query: Delete<useInternalEditorReturnType<S>['query'], 'deserialize'>;
  }
>;

/**
 * A Hook that that provides methods and information related to the entire editor state.
 * @param collector Collector function to consume values from the editor's state
 */
export function useEditor(): useEditorReturnType;
export function useEditor<S>(
  collect: EditorCollector<S>,
  options?: SubscribeOptions
): useEditorReturnType<S>;

export function useEditor<S>(
  collect?: any,
  options?: SubscribeOptions
): useEditorReturnType<S> {
  const {
    connectors,
    actions: internalActions,
    query,
    store,
    ...collected
  } = useInternalEditor(collect, options);

  // getPublicActions() strips six private actions and spreads the rest, so it always
  // returns a fresh object. It used to run unconditionally during render and then serve
  // as this useMemo's dependency, which meant the memo never hit: every useEditor call
  // site rebuilt `actions` on every render. Worse, the new identity cascaded — every
  // downstream useCallback/useMemo/useEffect that depends on `actions` was invalidated
  // too. With thousands of components each calling useEditor, that adds up.
  //
  // `internalActions` comes straight off the store instance (see useCollector), so its
  // identity is stable. Moving the computation inside the memo and depending on it
  // instead makes `actions` genuinely stable.
  const actions = useMemo(() => {
    const EditorActions = getPublicActions(internalActions);

    return {
      ...EditorActions,
      history: {
        ...EditorActions.history,
        ignore: (...args) =>
          getPublicActions(EditorActions.history.ignore(...args)),
        throttle: (...args) =>
          getPublicActions(EditorActions.history.throttle(...args)),
      },
    };
  }, [internalActions]);

  return {
    connectors,
    actions,
    query,
    store,
    ...(collected as any),
  };
}
