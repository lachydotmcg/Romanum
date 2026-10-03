// eslint-disable-next-line @typescript-eslint/no-require-imports -- Webpack's existing loader contract is CommonJS.
const ts = require('typescript');
module.exports = function(source) {
  if (this.resourcePath.endsWith('.css')) return `const style=document.createElement('style');style.textContent=${JSON.stringify(source)};document.head.appendChild(style);`;
  return ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX},fileName:this.resourcePath}).outputText;
};
