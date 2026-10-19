import { readFileSync, writeFileSync } from 'node:fs';
const template = readFileSync('ui/template.html', 'utf8');
const data = JSON.stringify(JSON.parse(readFileSync('ui/seed.json', 'utf8'))).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');
const css = readFileSync('ui/styles.css', 'utf8');
const js = readFileSync('ui/app.js', 'utf8').replace(/<\/script/gi, '<\\/script');
const html = template.replace('/*__STYLE__*/', css).replace('__DATA__', data).replace('/*__SCRIPT__*/', js);
if (/\/\*__(?:STYLE|SCRIPT)__\*\/|__DATA__/.test(html) || /\bsk-[A-Za-z0-9_-]{16,}/.test(html)) throw Error('Unsafe or incomplete HTML');
writeFileSync('app/experience.html', html);
console.log('Prepared browser experience.');
