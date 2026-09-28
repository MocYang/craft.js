import React from 'react';

import {
  NodeElementContext,
  NodeProvider,
  NodeElementProps,
} from './NodeContext';

import { RenderNodeToElement } from '../render/RenderNode';

export type { NodeElementProps } from './NodeContext';

export const NodeElement = ({ id, render }: NodeElementProps) => (
  <NodeElementContext.Provider value={NodeElement}>
    <NodeProvider id={id}>
      <RenderNodeToElement render={render} />
    </NodeProvider>
  </NodeElementContext.Provider>
);
