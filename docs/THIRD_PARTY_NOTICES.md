# Third-party notices

FL0W itself is licensed under **GPL-2.0-only** (see [`LICENSE`](../LICENSE)). It is built on third-party open-source packages
that keep their own licenses. This file lists the packages that are installed for a *production* installation
(`pnpm licenses list --prod`); development-only tools (TypeScript, ESLint, Vitest, …) are not part of what you run or ship.
Regenerate it after changing dependencies.

## Notes

- **Dual-licensed packages are used under the permissive option**: `dompurify` (MPL-2.0 OR Apache-2.0) under **MPL-2.0**,
  `@zone-eu/mailsplit` ((MIT OR EUPL-1.1+)) under **MIT**.
- **Apache-2.0 components** (`sharp`, `@swc/core`, `@swc/helpers`, `@swc/counter`, `@swc/types`, `detect-libc`,
  `baseline-browser-mapping`) arrive through Next.js and its tooling; FL0W's own source code does not use any Apache-2.0 library
  directly. The Apache License 2.0 is not compatible with *GPL-2.0-only* when both are combined into a single distributed work, so
  redistributing a *built* bundle or a Docker image that contains these components should be reviewed with that in mind (licensing
  FL0W as GPL-2.0-or-later would remove the question, because Apache-2.0 is compatible with GPLv3). The source repository itself
  contains no Apache-2.0 code.
- **LGPL-3.0-or-later**: `@img/sharp-libvips-*` (a native library used by the optional image optimiser `sharp`); it is loaded as a
  separate shared library and is not linked into FL0W's code.
- **CC-BY-4.0**: `caniuse-lite` — browser-support data from [caniuse.com](https://caniuse.com), used by build tooling; attribution
  to the caniuse.com contributors.
- **Copied source**: the UI components under `apps/web/src/components/ui` are generated from [shadcn/ui](https://ui.shadcn.com)
  (MIT, Copyright (c) 2023 shadcn). Icons come from [Lucide](https://lucide.dev) (ISC). The Monaco code editor
  (MIT, Microsoft) is loaded in the browser by `@monaco-editor/react`.
- **Trademarks**: n8n, Atlassian, Jira, Microsoft, Outlook, Telegram and Linux are trademarks of their respective owners; FL0W is
  not affiliated with them.

## Packages by license

### MIT (203)

`@babel/code-frame@7.29.7`, `@babel/compat-data@7.29.7`, `@babel/core@7.29.7`, `@babel/generator@7.29.8`, `@babel/helper-compilation-targets@7.29.7`, `@babel/helper-globals@7.29.7`, `@babel/helper-module-imports@7.29.7`, `@babel/helper-module-transforms@7.29.7`, `@babel/helper-string-parser@7.29.11`, `@babel/helper-validator-identifier@7.29.7`, `@babel/helper-validator-option@7.29.7`, `@babel/helpers@7.29.10`, `@babel/parser@7.29.11`, `@babel/template@7.29.7`, `@babel/traverse@7.29.10`, `@babel/types@7.29.11`, `@eloqnt/config@0.1.1`, `@eloqnt/format-json@0.1.0`, `@eloqnt/format-po@0.1.1`, `@esbuild/linux-x64@0.28.2`, `@floating-ui/core@1.8.0`, `@floating-ui/dom@1.8.0`, `@floating-ui/react-dom@2.1.9`, `@floating-ui/utils@0.2.12`, `@formatjs/fast-memoize@3.1.7`, `@formatjs/icu-messageformat-parser@3.5.18`, `@formatjs/icu-skeleton-parser@2.1.11`, `@formatjs/intl-localematcher@0.8.14`, `@img/colour@1.1.0`, `@jridgewell/gen-mapping@0.3.13`, `@jridgewell/remapping@2.3.5`, `@jridgewell/resolve-uri@3.1.2`, `@jridgewell/sourcemap-codec@1.6.0`, `@jridgewell/trace-mapping@0.3.31`, `@monaco-editor/loader@1.7.0`, `@monaco-editor/react@4.7.0`, `@next/env@16.4.3`, `@next/swc-linux-x64-gnu@16.4.3`, `@parcel/watcher-linux-x64-glibc@2.6.0`, `@parcel/watcher@2.6.0`, `@pinojs/redact@0.4.0`, `@radix-ui/number@1.1.3`, `@radix-ui/primitive@1.2.0`, `@radix-ui/react-accessible-icon@1.2.0`, `@radix-ui/react-accordion@1.3.1`, `@radix-ui/react-alert-dialog@1.2.1`, `@radix-ui/react-arrow@1.1.17`, `@radix-ui/react-aspect-ratio@1.2.0`, `@radix-ui/react-avatar@1.3.1`, `@radix-ui/react-checkbox@1.4.1`, `@radix-ui/react-collapsible@1.2.1`, `@radix-ui/react-collection@1.2.0`, `@radix-ui/react-compose-refs@1.1.5`, `@radix-ui/react-context-menu@2.4.1`, `@radix-ui/react-context@1.3.0`, `@radix-ui/react-dialog@1.3.1`, `@radix-ui/react-direction@1.2.0`, `@radix-ui/react-dismissable-layer@1.2.1`, `@radix-ui/react-dropdown-menu@2.2.1`, `@radix-ui/react-focus-guards@1.2.0`, `@radix-ui/react-focus-scope@1.3.1`, `@radix-ui/react-form@0.3.0`, `@radix-ui/react-hover-card@1.2.1`, `@radix-ui/react-id@1.1.4`, `@radix-ui/react-label@2.1.17`, `@radix-ui/react-menu@2.2.1`, `@radix-ui/react-menubar@1.2.1`, `@radix-ui/react-navigation-menu@1.4.1`, `@radix-ui/react-one-time-password-field@0.2.1`, `@radix-ui/react-password-toggle-field@0.2.1`, `@radix-ui/react-popover@1.3.1`, `@radix-ui/react-popper@1.4.0`, `@radix-ui/react-portal@1.2.0`, `@radix-ui/react-presence@1.1.11`, `@radix-ui/react-primitive@2.2.0`, `@radix-ui/react-progress@1.2.1`, `@radix-ui/react-radio-group@1.5.1`, `@radix-ui/react-roving-focus@1.2.1`, `@radix-ui/react-scroll-area@1.4.0`, `@radix-ui/react-select@2.4.1`, `@radix-ui/react-separator@1.2.0`, `@radix-ui/react-slider@1.6.1`, `@radix-ui/react-slot@1.5.0`, `@radix-ui/react-switch@1.4.1`, `@radix-ui/react-tabs@1.2.1`, `@radix-ui/react-toast@1.3.1`, `@radix-ui/react-toggle-group@1.2.1`, `@radix-ui/react-toggle@1.2.1`, `@radix-ui/react-toolbar@1.2.1`, `@radix-ui/react-tooltip@1.4.1`, `@radix-ui/react-use-callback-ref@1.1.5`, `@radix-ui/react-use-controllable-state@1.3.0`, `@radix-ui/react-use-effect-event@0.0.5`, `@radix-ui/react-use-escape-keydown@1.1.6`, `@radix-ui/react-use-is-hydrated@0.1.3`, `@radix-ui/react-use-layout-effect@1.1.4`, `@radix-ui/react-use-previous@1.1.4`, `@radix-ui/react-use-rect@1.1.4`, `@radix-ui/react-use-size@1.1.5`, `@radix-ui/react-visually-hidden@1.2.13`, `@radix-ui/rect@1.1.3`, `@schummar/icu-type-parser@1.21.5`, `@selderee/plugin-htmlparser2@0.12.0`, `@types/d3-color@3.1.3`, `@types/d3-drag@3.0.7`, `@types/d3-interpolate@3.0.4`, `@types/d3-selection@3.0.12`, `@types/d3-transition@3.0.9`, `@types/d3-zoom@3.0.9`, `@types/node@20.19.43`, `@types/react-dom@19.3.0`, `@types/react@19.3.0`, `@types/trusted-types@2.0.7`, `@xyflow/react@12.12.0`, `@xyflow/system@0.0.83`, `aria-hidden@1.2.6`, `atomic-sleep@1.0.0`, `browserslist@4.29.5`, `classcat@5.0.5`, `client-only@0.0.1`, `clsx@2.1.1`, `content-type@2.1.0`, `convert-source-map@2.0.0`, `csstype@3.2.3`, `debug@4.4.3`, `detect-node-es@1.1.0`, `dom-serializer@2.0.0`, `encoding-japanese@2.4.0`, `esbuild@0.28.2`, `escalade@3.2.0`, `gensync@1.0.0-beta.2`, `get-nonce@1.0.1`, `he@1.2.0`, `html-to-text@10.0.1`, `htmlparser2@10.1.0`, `iconv-lite@0.7.3`, `icu-minify@4.14.9`, `imapflow@2.10.0`, `ip-address@10.7.5`, `is-extglob@2.1.1`, `is-glob@4.0.3`, `js-tokens@4.0.0`, `jsesc@3.1.0`, `json5@2.2.3`, `leac@0.7.0`, `libbase64@1.4.1`, `libmime@5.6.3`, `libqp@3.0.1`, `linkify-it@5.0.2`, `mailparser@3.14.1`, `marked@14.0.0`, `monaco-editor@0.57.0`, `ms@2.1.3`, `nanoid@3.3.20`, `negotiator@1.1.0`, `next-intl-swc-plugin-extractor@4.14.9`, `next-intl@4.14.9`, `next-themes@0.4.6`, `next@16.4.3`, `node-addon-api@7.1.1`, `node-releases@2.0.60`, `on-exit-leak-free@2.1.2`, `parseley@0.13.1`, `peberminta@0.10.0`, `picomatch@4.0.7`, `pino-abstract-transport@3.0.0`, `pino-std-serializers@7.1.0`, `pino@10.3.1`, `po-parser@2.2.0`, `postcss@8.5.23`, `process-warning@5.1.1`, `punycode.js@2.3.1`, `quick-format-unescaped@4.0.4`, `radix-ui@1.8.1`, `react-dom@19.3.0`, `react-remove-scroll-bar@2.3.8`, `react-remove-scroll@2.7.2`, `react-style-singleton@2.2.3`, `react@19.3.0`, `real-require@0.2.0`, `safe-stable-stringify@2.5.0`, `safer-buffer@2.1.2`, `scheduler@0.28.0`, `selderee@0.12.0`, `smart-buffer@4.2.0`, `socks@2.8.10`, `sonic-boom@4.2.1`, `state-local@1.0.7`, `styled-jsx@5.1.6`, `tailwind-merge@3.7.0`, `thread-stream@4.2.0`, `tlds@1.261.0`, `tsx@4.23.15`, `tw-animate-css@1.4.0`, `uc.micro@2.1.0`, `undici-types@6.21.0`, `update-browserslist-db@1.3.4`, `use-callback-ref@1.3.3`, `use-intl@4.14.9`, `use-sidecar@1.1.3`, `use-sync-external-store@1.7.0`, `zod@4.6.7`, `zustand@4.5.7`

### ISC (15)

`d3-color@3.1.0`, `d3-dispatch@3.0.1`, `d3-drag@3.0.0`, `d3-interpolate@3.0.1`, `d3-selection@3.0.0`, `d3-timer@3.0.1`, `d3-transition@3.0.1`, `d3-zoom@3.0.0`, `electron-to-chromium@1.5.467`, `lru-cache@5.1.1`, `lucide-react@1.63.0`, `picocolors@1.1.1`, `semver@6.3.1`, `split2@4.2.0`, `yallist@3.1.1`

### Apache-2.0 (8)

`@img/sharp-linux-x64@0.35.5`, `@swc/core@1.16.20`, `@swc/counter@0.1.3`, `@swc/helpers@0.5.23`, `@swc/types@0.1.28`, `baseline-browser-mapping@2.11.34`, `detect-libc@2.1.2`, `sharp@0.35.5`

### BSD-2-Clause (4)

`domelementtype@2.3.0`, `domhandler@5.0.3`, `domutils@3.2.2`, `entities@4.5.0`

### BSD-3-Clause (4)

`d3-ease@3.0.1`, `deepmerge-ts@8.0.2`, `intl-messageformat@11.2.15`, `source-map-js@1.2.2`

### (MIT OR EUPL-1.1+) (1)

`@zone-eu/mailsplit@5.4.29`

### (MPL-2.0 OR Apache-2.0) (1)

`dompurify@3.4.15`

### 0BSD (1)

`tslib@2.8.1`

### Apache-2.0 AND MIT (1)

`@swc/core-linux-x64-gnu@1.16.20`

### CC-BY-4.0 (1)

`caniuse-lite@1.0.30001819`

### LGPL-3.0-or-later (1)

`@img/sharp-libvips-linux-x64@1.3.4`

### MIT-0 (1)

`nodemailer@10.3.1`
