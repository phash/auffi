// TypeScript 7 defaults `noUncheckedSideEffectImports` on — the
// side-effect `import "./styles.css"` in main.ts needs a module shape.
// Vite's documented pattern; the import stays a pure side effect.
declare module "*.css";
