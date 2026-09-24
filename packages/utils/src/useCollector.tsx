import { useState, useCallback, useRef, useEffect } from 'react';

import { SubscriberAndCallbacksFor, SubscribeOptions } from './useMethods';
import { ConditionallyMergeRecordTypes } from './utilityTypes';

type CollectorMethods<S extends SubscriberAndCallbacksFor<any, any>> = {
  actions: S['actions'];
  query: S['query'];
};

export type useCollectorReturnType<
  S extends SubscriberAndCallbacksFor<any, any>,
  C = null
> = ConditionallyMergeRecordTypes<C, CollectorMethods<S>>;
export function useCollector<S extends SubscriberAndCallbacksFor<any, any>, C>(
  store: S,
  collector?: (
    state: ReturnType<S['getState']>['current'],
    query: S['query']
  ) => C,
  options?: SubscribeOptions
): useCollectorReturnType<S, C> {
  const { subscribe, getState, actions, query } = store;

  const initial = useRef(true);
  const collected = useRef<any>(null);
  const collectorRef = useRef(collector);
  collectorRef.current = collector;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const dependencyKey = JSON.stringify(options?.dependencies || null);
  const subscribedDependencyKey = useRef(dependencyKey);

  const onCollect = useCallback(
    (collected) => {
      return { ...collected, actions, query };
    },
    [actions, query]
  );

  // Collect states for initial render
  if (initial.current && collector) {
    collected.current = collector(getState(), query);
    initial.current = false;
  }

  const [renderCollected, setRenderCollected] = useState(
    onCollect(collected.current)
  );

  // Collect states on state change
  useEffect(() => {
    const dependenciesChanged =
      subscribedDependencyKey.current !== dependencyKey;
    subscribedDependencyKey.current = dependencyKey;

    let unsubscribe;
    if (collectorRef.current) {
      const initialCollected = dependenciesChanged
        ? collectorRef.current(getState(), query)
        : collected.current;

      if (dependenciesChanged) {
        collected.current = initialCollected;
        setRenderCollected(onCollect(initialCollected));
      }

      unsubscribe = subscribe(
        (current) => collectorRef.current(current, query),
        (next) => {
          // Keep the ref current so a re-subscribe (eg: dependencies changed)
          // seeds its baseline from the latest value rather than the first render's.
          collected.current = next;
          setRenderCollected(onCollect(next));
        },
        false,
        {
          ...optionsRef.current,
          // We already collected this value for the initial render. Handing it over
          // stops the first notify from reporting a change that never happened.
          initialCollected,
        }
      );
    }
    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [dependencyKey, getState, onCollect, query, subscribe]);

  return renderCollected;
}
