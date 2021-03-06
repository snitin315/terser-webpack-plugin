import path from 'path';
import os from 'os';

import { SourceMapConsumer } from 'source-map';
import { SourceMapSource, RawSource, ConcatSource } from 'webpack-sources';
import RequestShortener from 'webpack/lib/RequestShortener';
import {
  util,
  ModuleFilenameHelpers,
  SourceMapDevToolPlugin,
  javascript,
  version as webpackVersion,
} from 'webpack';
import validateOptions from 'schema-utils';
import serialize from 'serialize-javascript';
import terserPackageJson from 'terser/package.json';
import pLimit from 'p-limit';
import Worker from 'jest-worker';

import schema from './options.json';

import { minify as minifyFn } from './minify';

const warningRegex = /\[.+:([0-9]+),([0-9]+)\]/;

class TerserPlugin {
  constructor(options = {}) {
    validateOptions(schema, options, {
      name: 'Terser Plugin',
      baseDataPath: 'options',
    });

    const {
      minify,
      terserOptions = {},
      test = /\.m?js(\?.*)?$/i,
      warningsFilter = () => true,
      extractComments = true,
      sourceMap,
      cache = true,
      cacheKeys = (defaultCacheKeys) => defaultCacheKeys,
      parallel = true,
      include,
      exclude,
    } = options;

    this.options = {
      test,
      warningsFilter,
      extractComments,
      sourceMap,
      cache,
      cacheKeys,
      parallel,
      include,
      exclude,
      minify,
      terserOptions,
    };
  }

  static isSourceMap(input) {
    // All required options for `new SourceMapConsumer(...options)`
    // https://github.com/mozilla/source-map#new-sourcemapconsumerrawsourcemap
    return Boolean(
      input &&
        input.version &&
        input.sources &&
        Array.isArray(input.sources) &&
        typeof input.mappings === 'string'
    );
  }

  static buildError(error, file, sourceMap, requestShortener) {
    if (error.line) {
      const original =
        sourceMap &&
        sourceMap.originalPositionFor({
          line: error.line,
          column: error.col,
        });

      if (original && original.source && requestShortener) {
        return new Error(
          `${file} from Terser\n${error.message} [${requestShortener.shorten(
            original.source
          )}:${original.line},${original.column}][${file}:${error.line},${
            error.col
          }]${
            error.stack
              ? `\n${error.stack.split('\n').slice(1).join('\n')}`
              : ''
          }`
        );
      }

      return new Error(
        `${file} from Terser\n${error.message} [${file}:${error.line},${
          error.col
        }]${
          error.stack ? `\n${error.stack.split('\n').slice(1).join('\n')}` : ''
        }`
      );
    }

    if (error.stack) {
      return new Error(`${file} from Terser\n${error.stack}`);
    }

    return new Error(`${file} from Terser\n${error.message}`);
  }

  static buildWarning(
    warning,
    file,
    sourceMap,
    requestShortener,
    warningsFilter
  ) {
    let warningMessage = warning;
    let locationMessage = '';
    let source;

    if (sourceMap) {
      const match = warningRegex.exec(warning);

      if (match) {
        const line = +match[1];
        const column = +match[2];
        const original = sourceMap.originalPositionFor({
          line,
          column,
        });

        if (
          original &&
          original.source &&
          original.source !== file &&
          requestShortener
        ) {
          ({ source } = original);
          warningMessage = `${warningMessage.replace(warningRegex, '')}`;

          locationMessage = `[${requestShortener.shorten(original.source)}:${
            original.line
          },${original.column}]`;
        }
      }
    }

    if (warningsFilter && !warningsFilter(warning, file, source)) {
      return null;
    }

    return `Terser Plugin: ${warningMessage}${locationMessage}`;
  }

  static removeQueryString(filename) {
    let targetFilename = filename;

    const queryStringIdx = targetFilename.indexOf('?');

    if (queryStringIdx >= 0) {
      targetFilename = targetFilename.substr(0, queryStringIdx);
    }

    return targetFilename;
  }

  static isWebpack4() {
    return webpackVersion[0] === '4';
  }

  static getAvailableNumberOfCores(parallel) {
    // In some cases cpus() returns undefined
    // https://github.com/nodejs/node/issues/19022
    const cpus = os.cpus() || { length: 1 };

    return parallel === true
      ? cpus.length - 1
      : Math.min(Number(parallel) || 0, cpus.length - 1);
  }

  *taskGenerator(compiler, compilation, allExtractedComments, file) {
    const assetSource = compilation.assets[file];

    let input;
    let inputSourceMap;

    // TODO refactor after drop webpack@4, webpack@5 always has `sourceAndMap` on sources
    if (this.options.sourceMap && assetSource.sourceAndMap) {
      const { source, map } = assetSource.sourceAndMap();

      input = source;

      if (map) {
        if (TerserPlugin.isSourceMap(map)) {
          inputSourceMap = map;
        } else {
          inputSourceMap = map;

          compilation.warnings.push(
            new Error(`${file} contains invalid source map`)
          );
        }
      }
    } else {
      input = assetSource.source();
      inputSourceMap = null;
    }

    if (Buffer.isBuffer(input)) {
      input = input.toString();
    }

    // Handling comment extraction
    let commentsFilename = false;

    if (this.options.extractComments) {
      commentsFilename =
        this.options.extractComments.filename || '[file].LICENSE.txt[query]';

      let query = '';
      let filename = file;

      const querySplit = filename.indexOf('?');

      if (querySplit >= 0) {
        query = filename.substr(querySplit);
        filename = filename.substr(0, querySplit);
      }

      const lastSlashIndex = filename.lastIndexOf('/');
      const basename =
        lastSlashIndex === -1 ? filename : filename.substr(lastSlashIndex + 1);
      const data = { filename, basename, query };

      commentsFilename = compilation.getPath(commentsFilename, data);
    }

    const callback = (taskResult) => {
      let { code } = taskResult;
      const { error, map, warnings } = taskResult;
      const { extractedComments } = taskResult;

      let sourceMap = null;

      if (
        (error || (warnings && warnings.length > 0)) &&
        inputSourceMap &&
        TerserPlugin.isSourceMap(inputSourceMap)
      ) {
        sourceMap = new SourceMapConsumer(inputSourceMap);
      }

      // Handling results
      // Error case: add errors, and go to next file
      if (error) {
        compilation.errors.push(
          TerserPlugin.buildError(
            error,
            file,
            sourceMap,
            new RequestShortener(compiler.context)
          )
        );

        return;
      }

      const hasExtractedComments =
        commentsFilename && extractedComments && extractedComments.length > 0;
      const hasBannerForExtractedComments =
        this.options.extractComments.banner !== false;

      let outputSource;
      let shebang;

      if (
        hasExtractedComments &&
        hasBannerForExtractedComments &&
        code.startsWith('#!')
      ) {
        const firstNewlinePosition = code.indexOf('\n');

        shebang = code.substring(0, firstNewlinePosition);
        code = code.substring(firstNewlinePosition + 1);
      }

      if (map) {
        outputSource = new SourceMapSource(
          code,
          file,
          map,
          input,
          inputSourceMap,
          true
        );
      } else {
        outputSource = new RawSource(code);
      }

      // Write extracted comments to commentsFilename
      if (hasExtractedComments) {
        let banner;

        // Add a banner to the original file
        if (hasBannerForExtractedComments) {
          banner =
            this.options.extractComments.banner ||
            `For license information please see ${path
              .relative(path.dirname(file), commentsFilename)
              .replace(/\\/g, '/')}`;

          if (typeof banner === 'function') {
            banner = banner(commentsFilename);
          }

          if (banner) {
            outputSource = new ConcatSource(
              shebang ? `${shebang}\n` : '',
              `/*! ${banner} */\n`,
              outputSource
            );
          }
        }

        if (!allExtractedComments[commentsFilename]) {
          // eslint-disable-next-line no-param-reassign
          allExtractedComments[commentsFilename] = new Set();
        }

        extractedComments.forEach((comment) => {
          // Avoid re-adding banner
          // Developers can use different banner for different names, but this setting should be avoided, it is not safe
          if (banner && comment === `/*! ${banner} */`) {
            return;
          }

          allExtractedComments[commentsFilename].add(comment);
        });

        // Extracted comments from child compilation
        const previousExtractedComments = compilation.assets[commentsFilename];

        if (previousExtractedComments) {
          const previousExtractedCommentsSource = previousExtractedComments.source();

          // Restore original comments and re-add them
          previousExtractedCommentsSource
            .replace(/\n$/, '')
            .split('\n\n')
            .forEach((comment) => {
              allExtractedComments[commentsFilename].add(comment);
            });
        }
      }

      // Updating assets
      // eslint-disable-next-line no-param-reassign
      compilation.assets[file] = outputSource;

      // Handling warnings
      if (warnings && warnings.length > 0) {
        warnings.forEach((warning) => {
          const builtWarning = TerserPlugin.buildWarning(
            warning,
            file,
            sourceMap,
            new RequestShortener(compiler.context),
            this.options.warningsFilter
          );

          if (builtWarning) {
            compilation.warnings.push(builtWarning);
          }
        });
      }
    };

    const task = {
      file,
      input,
      inputSourceMap,
      commentsFilename,
      extractComments: this.options.extractComments,
      terserOptions: this.options.terserOptions,
      minify: this.options.minify,
      callback,
    };

    if (TerserPlugin.isWebpack4()) {
      const {
        outputOptions: { hashSalt, hashDigest, hashDigestLength, hashFunction },
      } = compilation;
      const hash = util.createHash(hashFunction);

      if (hashSalt) {
        hash.update(hashSalt);
      }

      hash.update(input);

      const digest = hash.digest(hashDigest);

      if (this.options.cache) {
        const defaultCacheKeys = {
          terser: terserPackageJson.version,
          // eslint-disable-next-line global-require
          'terser-webpack-plugin': require('../package.json').version,
          'terser-webpack-plugin-options': this.options,
          nodeVersion: process.version,
          filename: file,
          contentHash: digest.substr(0, hashDigestLength),
        };

        task.cacheKeys = this.options.cacheKeys(defaultCacheKeys, file);
      }
    } else {
      // For webpack@5 cache
      task.assetSource = assetSource;

      task.cacheKeys = {
        terser: terserPackageJson.version,
        // eslint-disable-next-line global-require
        'terser-webpack-plugin': require('../package.json').version,
        'terser-webpack-plugin-options': this.options,
      };
    }

    yield task;
  }

  async runTasks(assetNames, getTaskForAsset, cache) {
    const availableNumberOfCores = TerserPlugin.getAvailableNumberOfCores(
      this.options.parallel
    );

    let concurrency = Infinity;
    let worker;

    if (availableNumberOfCores > 0) {
      // Do not create unnecessary workers when the number of files is less than the available cores, it saves memory
      const numWorkers = Math.min(assetNames.length, availableNumberOfCores);

      concurrency = numWorkers;

      worker = new Worker(require.resolve('./minify'), { numWorkers });

      // https://github.com/facebook/jest/issues/8872#issuecomment-524822081
      const workerStdout = worker.getStdout();

      if (workerStdout) {
        workerStdout.on('data', (chunk) => {
          return process.stdout.write(chunk);
        });
      }

      const workerStderr = worker.getStderr();

      if (workerStderr) {
        workerStderr.on('data', (chunk) => {
          return process.stderr.write(chunk);
        });
      }
    }

    const limit = pLimit(concurrency);
    const scheduledTasks = [];

    for (const assetName of assetNames) {
      const enqueue = async (task) => {
        let taskResult;

        try {
          if (worker) {
            taskResult = await worker.transform(serialize(task));
          } else {
            taskResult = minifyFn(task);
          }
        } catch (error) {
          taskResult = { error };
        }

        if (cache.isEnabled() && !taskResult.error) {
          await cache.store(task, taskResult);
        }

        task.callback(taskResult);

        return taskResult;
      };

      scheduledTasks.push(
        limit(async () => {
          const task = getTaskForAsset(assetName).next().value;

          if (!task) {
            // Something went wrong, for example the `cacheKeys` option throw an error
            return Promise.resolve();
          }

          if (cache.isEnabled()) {
            let taskResult;

            try {
              taskResult = await cache.get(task);
            } catch (ignoreError) {
              return enqueue(task);
            }

            task.callback(taskResult);

            return Promise.resolve();
          }

          return enqueue(task);
        })
      );
    }

    await Promise.all(scheduledTasks);

    if (worker) {
      await worker.end();
    }
  }

  apply(compiler) {
    const { devtool, output, plugins } = compiler.options;

    this.options.sourceMap =
      typeof this.options.sourceMap === 'undefined'
        ? (devtool &&
            !devtool.includes('eval') &&
            !devtool.includes('cheap') &&
            (devtool.includes('source-map') ||
              // Todo remove when `webpack@4` support will be dropped
              devtool.includes('sourcemap'))) ||
          (plugins &&
            plugins.some(
              (plugin) =>
                plugin instanceof SourceMapDevToolPlugin &&
                plugin.options &&
                plugin.options.columns
            ))
        : Boolean(this.options.sourceMap);

    if (
      typeof this.options.terserOptions.module === 'undefined' &&
      typeof output.module !== 'undefined'
    ) {
      this.options.terserOptions.module = output.module;
    }

    if (
      typeof this.options.terserOptions.ecma === 'undefined' &&
      typeof output.ecmaVersion !== 'undefined'
    ) {
      this.options.terserOptions.ecma = output.ecmaVersion;
    }

    const matchObject = ModuleFilenameHelpers.matchObject.bind(
      // eslint-disable-next-line no-undefined
      undefined,
      this.options
    );

    const optimizeFn = async (compilation, chunksOrAssets) => {
      let assetNames;

      if (TerserPlugin.isWebpack4()) {
        assetNames = []
          .concat(Array.from(compilation.additionalChunkAssets || []))
          .concat(
            Array.from(chunksOrAssets).reduce(
              (acc, chunk) => acc.concat(Array.from(chunk.files || [])),
              []
            )
          )
          .concat(Object.keys(compilation.assets))
          .filter((file, index, assets) => assets.indexOf(file) === index)
          .filter((file) => matchObject(file));
      } else {
        assetNames = []
          .concat(Object.keys(chunksOrAssets))
          .filter((file) => matchObject(file));
      }

      if (assetNames.length === 0) {
        return Promise.resolve();
      }

      const allExtractedComments = {};
      const getTaskForAsset = this.taskGenerator.bind(
        this,
        compiler,
        compilation,
        allExtractedComments
      );
      const CacheEngine = TerserPlugin.isWebpack4()
        ? // eslint-disable-next-line global-require
          require('./Webpack4Cache').default
        : // eslint-disable-next-line global-require
          require('./Webpack5Cache').default;
      const cache = new CacheEngine(compilation, { cache: this.options.cache });

      await this.runTasks(assetNames, getTaskForAsset, cache);

      Object.keys(allExtractedComments).forEach((commentsFilename) => {
        const extractedComments = Array.from(
          allExtractedComments[commentsFilename]
        )
          .sort()
          .join('\n\n');

        // eslint-disable-next-line no-param-reassign
        compilation.assets[commentsFilename] = new RawSource(
          `${extractedComments}\n`
        );
      });

      return Promise.resolve();
    };

    const plugin = { name: this.constructor.name };

    compiler.hooks.compilation.tap(plugin, (compilation) => {
      if (this.options.sourceMap) {
        compilation.hooks.buildModule.tap(plugin, (moduleArg) => {
          // to get detailed location info about errors
          // eslint-disable-next-line no-param-reassign
          moduleArg.useSourceMap = true;
        });
      }

      if (TerserPlugin.isWebpack4()) {
        const { mainTemplate, chunkTemplate } = compilation;
        const data = serialize({
          terser: terserPackageJson.version,
          terserOptions: this.options.terserOptions,
        });

        // Regenerate `contenthash` for minified assets
        for (const template of [mainTemplate, chunkTemplate]) {
          template.hooks.hashForChunk.tap(plugin, (hash) => {
            hash.update('TerserPlugin');
            hash.update(data);
          });
        }

        compilation.hooks.optimizeChunkAssets.tapPromise(
          plugin,
          optimizeFn.bind(this, compilation)
        );
      } else {
        const hooks = javascript.JavascriptModulesPlugin.getCompilationHooks(
          compilation
        );
        const data = serialize({
          terser: terserPackageJson.version,
          terserOptions: this.options.terserOptions,
        });

        hooks.chunkHash.tap(plugin, (chunk, hash) => {
          hash.update('TerserPlugin');
          hash.update(data);
        });

        compilation.hooks.optimizeAssets.tapPromise(
          plugin,
          optimizeFn.bind(this, compilation)
        );
      }
    });
  }
}

export default TerserPlugin;
