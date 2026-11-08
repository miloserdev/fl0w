"use client";

import type { BeforeMount } from "@monaco-editor/react";
import dynamic from "next/dynamic";
import { useTheme } from "next-themes";

const Monaco = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => <div className="text-muted-foreground p-3 text-sm">…</div>,
});

// Block code is a function body: `return` and `await` at the top level are legal here.
const IGNORED_TS_CODES = [1108, 1375, 1378];
// The editor background is transparent — otherwise it would paint over the window's "glass" it sits in.
const CLEAR = { "editor.background": "#00000000", "editorGutter.background": "#00000000" };
const ENV_LIB_URI = "inmemory://fl0w/env.d.ts";

export function CodeEditor({
  language,
  value,
  onChange,
  envTypes,
}: {
  language: "css" | "javascript";
  value: string;
  onChange: (code: string) => void;
  /** d.ts of the environment (inputs / params / log / fetch) for JS autocompletion. */
  envTypes?: string;
}) {
  const { resolvedTheme } = useTheme();

  const beforeMount: BeforeMount = (monaco) => {
    monaco.editor.defineTheme("fl0w-light", { base: "vs", inherit: true, rules: [], colors: CLEAR });
    monaco.editor.defineTheme("fl0w-dark", { base: "vs-dark", inherit: true, rules: [], colors: CLEAR });
    if (language !== "javascript") return;
    const js = monaco.languages.typescript.javascriptDefaults;
    js.setCompilerOptions({
      target: monaco.languages.typescript.ScriptTarget.ES2020,
      allowNonTsExtensions: true,
      checkJs: true,
    });
    js.setDiagnosticsOptions({ diagnosticCodesToIgnore: IGNORED_TS_CODES });
    js.setExtraLibs(envTypes ? [{ content: envTypes, filePath: ENV_LIB_URI }] : []);
  };

  return (
    <Monaco
      language={language}
      // uncontrolled mode: with fast typing the `value` prop lags behind the editor text, and the wrapper
      // overwrote the whole document — the cursor jumped to the end. To replace the value from outside, use a key on the parent.
      defaultValue={value}
      theme={resolvedTheme === "dark" ? "fl0w-dark" : "fl0w-light"}
      beforeMount={beforeMount}
      onChange={(v) => onChange(v ?? "")}
      options={{
        minimap: { enabled: false },
        fontSize: 12,
        lineNumbers: "on",
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 2,
        wordWrap: "on",
      }}
    />
  );
}
