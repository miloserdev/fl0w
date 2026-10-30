"use client";

import type { BeforeMount } from "@monaco-editor/react";
import dynamic from "next/dynamic";
import { useTheme } from "next-themes";

const Monaco = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => <div className="text-muted-foreground p-3 text-sm">…</div>,
});

// Код блока — тело функции: `return` и `await` на верхнем уровне здесь законны.
const IGNORED_TS_CODES = [1108, 1375, 1378];
// Фон редактора прозрачный — иначе он закрасит «стекло» окна, в котором лежит.
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
  /** d.ts окружения (inputs / params / log / fetch) для автокомплита в JS. */
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
      // неуправляемый режим: при быстром наборе prop `value` отстаёт от текста в редакторе, и обёртка
      // перезаписывала документ целиком — курсор прыгал в конец. Внешняя замена значения — через key у родителя.
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
