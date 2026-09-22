# @deepctrls/craftjs

A maintained fork of [Craft.js](https://github.com/prevwong/craft.js), based on
`@craftjs/core@0.2.12`. This package contains the core React page editor framework.
It retains the upstream MIT license and depends on `@craftjs/utils`.

## Install

```sh
npm install @deepctrls/craftjs
```

```tsx
import { Editor, Frame, Element, useEditor, useNode } from '@deepctrls/craftjs';
```

React 16.8, 17, 18, and 19 are supported by the upstream peer dependency range.

## Migrate an existing Craft.js project

To preserve existing imports and share the same core instance with integrations
such as `@craftjs/layers`, install this fork under the original package name:

```sh
npm install @craftjs/core@npm:@deepctrls/craftjs@0.2.13
```

Continue importing from `@craftjs/core` in that project. Choose either direct
installation or the alias; do not install both core packages in one application,
because their React contexts would be separate.

## Changes in 0.2.13

- Avoid full-tree serialization when no node-change callback is configured.
- Support callbacks added or replaced at runtime with `actions.setOptions`.
- Unsubscribe on unmount and during React StrictMode effect cleanup.

## Development and publishing

The monorepo keeps the upstream workspace names so examples and internal
dependencies continue to resolve. The release process builds the utilities and
core, then stages the renamed core package with CommonJS, ES modules, and
TypeScript declarations in `release/logic-craftjs`.

From a checkout with its development dependencies installed:

```sh
yarn test --runInBand
yarn pack:logic
npm publish ./release/logic-craftjs --access public --registry=https://registry.npmjs.org/
```

Release metadata and the fork version are maintained in
`scripts/logic-package.json`. Publishing requires npm access to the `@deepctrls`
scope and completion of npm's authentication requirements.

## Documentation and license

- [Craft.js documentation](https://craft.js.org/docs/overview)
- [Fork source and issues](https://github.com/hnldlsjzt/craft.js)
- MIT, original copyright retained in `LICENSE`.
