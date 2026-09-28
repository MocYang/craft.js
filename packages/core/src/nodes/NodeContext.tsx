import React from 'react';

import { NodeId } from '../interfaces';

export type NodeContextType = {
  id: NodeId;
  related?: boolean;
};

export type NodeElementProps = {
  id: NodeId;
  render?: React.ReactElement;
};

export const NodeElementContext = React.createContext<
  React.ComponentType<NodeElementProps>
>(null);

export const NodeContext = React.createContext<NodeContextType>(null);

export type NodeProviderProps = Omit<NodeContextType, 'connectors'> & {
  children?: React.ReactNode;
};

export const NodeProvider = ({
  id,
  related = false,
  children,
}: NodeProviderProps) => {
  return (
    <NodeContext.Provider value={{ id, related }}>
      {children}
    </NodeContext.Provider>
  );
};
