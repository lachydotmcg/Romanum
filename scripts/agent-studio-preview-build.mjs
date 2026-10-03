import path from 'node:path';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require=createRequire(import.meta.url);
const { webpack }=require('next/dist/compiled/webpack/webpack');
const output=path.resolve('artifacts/studio-preview');
await mkdir(output,{recursive:true});
const compiler=webpack({mode:'production',target:'web',entry:path.resolve('scripts/fixtures/agent-studio-preview.tsx'),output:{path:output,filename:'preview.js'},resolve:{extensions:['.tsx','.ts','.js'],symlinks:false},module:{rules:[{test:/\.(tsx?|css)$/,use:path.resolve('scripts/agent-studio-preview-loader.cjs')}]},devtool:false,optimization:{minimize:false},performance:false});
await new Promise((resolve,reject)=>compiler.run((error,stats)=>{compiler.close(()=>{});if(error||stats.hasErrors())reject(error??new Error(stats.toString({all:false,errors:true})));else resolve();}));
const bundle=path.join(output,'preview.js');
await writeFile(bundle,'/* eslint-disable -- Generated offline preview from linted source and existing dependencies. */\n'+await readFile(bundle,'utf8'));
await writeFile(path.join(output,'index.html'),'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Romanum · Authored Studio review fixture</title><style>html{color-scheme:dark;background:#000}body{margin:0;background:#000}body>aside{height:48px;border-bottom:1px solid #262626;color:#ededed;display:flex;align-items:center;gap:18px;padding:0 36px;font:600 14px Arial}body>aside span{color:#838383;font:10px Arial;letter-spacing:1px}@media(max-width:760px){body>aside{padding:0 16px}}</style></head><body><aside>Romanum<span>OFFLINE FIXTURE PREVIEW</span></aside><div id="root"></div><script src="preview.js"></script></body></html>');
console.log(JSON.stringify({offlinePreview:path.join(output,'index.html'),listenersStarted:0,newDependencies:0,liveStudioAccessed:false}));
