import React from 'react';

import { DefaultRender } from './DefaultRender';

import { useInternalEditor } from '../editor/useInternalEditor';
import { useInternalNode } from '../nodes/useInternalNode';

type RenderNodeToElementProps = {
  render?: React.ReactElement;
  children?: React.ReactNode;
};

/**
 * `onRender` is static configuration, but this component is mounted once per Node.
 * Without a declared dependency every rendered Node registers a *global* subscriber,
 * so a 1000-node tree runs 1000 collectors on every single dispatch.
 *
 * Declared at module scope so the subscription isn't torn down and rebuilt on each render.
 */
const ON_RENDER_SUBSCRIPTION = {
  dependencies: [['options', 'onRender']],
} as const;

export const RenderNodeToElement = ({ render }: RenderNodeToElementProps) => {
  const { hidden } = useInternalNode((node) => ({
    hidden: node.data.hidden,
  }));

  const { onRender } = useInternalEditor(
    (state) => ({
      onRender: state.options.onRender,
    }),
    ON_RENDER_SUBSCRIPTION
  );

  // don't display the node since it's hidden
  if (hidden) {
    return null;
  }

  return React.createElement(onRender, { render: render || <DefaultRender /> });
};
