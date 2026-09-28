import React, { useContext, useMemo } from 'react';

import { SimpleElement } from './SimpleElement';

import { NodeId } from '../interfaces';
import { NodeElementContext } from '../nodes/NodeContext';
import { useInternalNode } from '../nodes/useInternalNode';

export const DefaultRender = () => {
  const NodeElement = useContext(NodeElementContext);
  const { type, props, nodes, hydrationTimestamp } = useInternalNode(
    (node) => ({
      type: node.data.type,
      props: node.data.props,
      nodes: node.data.nodes,
      hydrationTimestamp: node._hydrationTimestamp,
    })
  );

  return useMemo(() => {
    let children = props.children;

    if (NodeElement && nodes && nodes.length > 0) {
      children = (
        <React.Fragment>
          {nodes.map((id: NodeId) => (
            <NodeElement id={id} key={id} />
          ))}
        </React.Fragment>
      );
    }

    const render = React.createElement(type, props, children);

    if (typeof type == 'string') {
      return <SimpleElement render={render} />;
    }

    return render;
    // eslint-disable-next-line  react-hooks/exhaustive-deps
  }, [type, props, hydrationTimestamp, nodes, NodeElement]);
};
