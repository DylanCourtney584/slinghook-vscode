import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// VS Code loads extensions as CommonJS, so the ES module sources are bundled into one .cjs file
const ctx = await esbuild.context({
    entryPoints: ['src/extension.js'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    outfile: 'dist/extension.cjs',
    external: ['vscode'],
    sourcemap: !production,
    minify: production,
    logLevel: 'info'
});

if (watch) {
    await ctx.watch();
} else {
    await ctx.rebuild();
    await ctx.dispose();
}
