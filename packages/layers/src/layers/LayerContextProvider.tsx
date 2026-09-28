import { useEditor, ROOT_NODE } from '@craftjs/core';
import { wrapConnectorHooks } from '@craftjs/utils';
import React, {
  useMemo,
  useContext,
  useRef,
  useEffect,
  useLayoutEffect,
  useState,
} from 'react';

import { LayerContext, LayerContextType } from './LayerContext';
import { useLayer } from './useLayer';

import { useLayerEventHandler } from '../events/LayerEventContext';
import { LayerManagerContext } from '../manager';
import { useLayerManager } from '../manager/useLayerManager';

export type LayerContextProviderProps = Omit<LayerContextType, 'connectors'>;

export const LayerContextProvider = ({
  id,
  depth,
}: LayerContextProviderProps) => {
  const handlers = useLayerEventHandler();

  const { store } = useContext(LayerManagerContext);
  const storeRef = useRef(store);
  storeRef.current = store;

  const connectorsUsage = useMemo(() => handlers.createConnectorsUsage(), [
    handlers,
  ]);

  const connectors = useMemo(
    () => wrapConnectorHooks(connectorsUsage.connectors),
    [connectorsUsage]
  );

  useEffect(() => {
    connectorsUsage.register();

    return () => {
      connectorsUsage.cleanup();
    };
  }, [connectorsUsage]);

  const { exists } = useEditor((state) => ({
    exists: !!state.nodes[id],
  }));

  if (!exists) {
    return null;
  }

  return (
    <LayerContext.Provider value={{ id, depth, connectors }}>
      <LayerNode />
    </LayerContext.Provider>
  );
};

export const LayerNode = () => {
  const { id, depth, children, expanded } = useLayer((layer) => ({
    expanded: layer.expanded,
  }));

  const { data, shouldBeExpanded } = useEditor((state, query) => {
    // TODO: handle multiple selected elements
    const selected = query.getEvent('selected').first();

    return {
      data: state.nodes[id] && state.nodes[id].data,
      shouldBeExpanded:
        selected && query.node(selected).ancestors(true).includes(id),
    };
  });

  const {
    actions: { registerLayer, toggleLayer },
    renderLayer,
    expandRootOnLoad,
  } = useLayerManager((state) => ({
    renderLayer: state.options.renderLayer,
    expandRootOnLoad: state.options.expandRootOnLoad,
  }));

  const [isRegistered, setRegistered] = useState(false);

  useLayoutEffect(() => {
    registerLayer(id);
    setRegistered(true);
  }, [registerLayer, id]);

  const expandedRef = useRef<boolean>(expanded);
  expandedRef.current = expanded;

  const shouldBeExpandedOnLoad = useRef<boolean>(
    expandRootOnLoad && id === ROOT_NODE
  );

  useEffect(() => {
    if (!expandedRef.current && shouldBeExpanded) {
      toggleLayer(id);
    }
  }, [toggleLayer, id, shouldBeExpanded]);

  useEffect(() => {
    if (shouldBeExpandedOnLoad.current) {
      toggleLayer(id);
    }
  }, [toggleLayer, id]);

  return data && isRegistered ? (
    <div className={`craft-layer-node ${id}`}>
      {React.createElement(
        renderLayer,
        {},
        children && expanded
          ? children.map((id) => (
              <LayerContextProvider key={id} id={id} depth={depth + 1} />
            ))
          : null
      )}
    </div>
  ) : null;
};
