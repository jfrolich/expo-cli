import { fileExists, getConfig, getWebOutputPath } from '@expo/config';
import { isAvailableAsync, sharpAsync } from '@expo/image-utils';
import JsonFile from '@expo/json-file';
import chalk from 'chalk';
import crypto from 'crypto';
import { ensureDirSync, move, readFileSync, statSync, unlinkSync } from 'fs-extra';
import glob from 'globby';
import { basename, join, parse, relative } from 'path';
import prettyBytes from 'pretty-bytes';
import temporary from 'tempy';

export type AssetOptimizationState = { [hash: string]: boolean };

// Read the contents of assets.json under .expo-shared folder. Create the file/directory if they don't exist.
async function readAssetJsonAsync(
  projectDir: string
): Promise<{ assetJson: JsonFile<AssetOptimizationState>; assetInfo: AssetOptimizationState }> {
  const dirPath = join(projectDir, '.expo-shared');

  ensureDirSync(dirPath);

  const assetJson = new JsonFile<AssetOptimizationState>(join(dirPath, 'assets.json'));
  if (!fileExists(assetJson.file)) {
    console.log();
    console.log(
      chalk.magenta(
        `\u203A Creating ${chalk.bold('.expo-shared/assets.json')} in the project's root directory.`
      )
    );
    console.log(
      chalk.magenta`\u203A This file is autogenerated and should not be edited directly.`
    );
    console.log(
      chalk.magenta`\u203A You should commit this to git so that asset state is shared between collaborators.`
    );
    console.log();

    await assetJson.writeAsync({});
  }
  const assetInfo = await assetJson.readAsync();
  return { assetJson, assetInfo };
}

// Compress an inputted jpg or png
async function optimizeImageAsync(
  projectRoot: string,
  inputPath: string,
  quality: number
): Promise<string> {
  console.log(`\u203A Checking ${chalk.reset.bold(relative(projectRoot, inputPath))}`);

  const outputPath = temporary.directory();
  await sharpAsync({
    input: inputPath,
    output: outputPath,
    quality,
    // https://sharp.pixelplumbing.com/en/stable/api-output/#parameters_4
    adaptiveFiltering: true,
  });
  return join(outputPath, basename(inputPath));
}

// Add .orig extension to a filename in a path string
function createNewFilename(imagePath: string): string {
  const { dir, name, ext } = parse(imagePath);
  return join(dir, `${name}.orig${ext}`);
}

// Find all project assets under assetBundlePatterns in app.json excluding node_modules.
// If --include of --exclude flags were passed in those results are filtered out.
async function getAssetFilesAsync(
  projectDir: string,
  options: OptimizationOptions
): Promise<{ allFiles: string[]; selectedFiles: string[] }> {
  const { exp } = getConfig(projectDir, {
    skipSDKVersionRequirement: true,
  });
  const webOutputPath = await getWebOutputPath(exp);
  const { assetBundlePatterns } = exp;
  const globOptions = {
    cwd: projectDir,
    ignore: ['**/node_modules/**', '**/ios/**', '**/android/**', `**/${webOutputPath}/**`],
  };

  // All files must be returned even if flags are passed in to properly update assets.json
  const allFiles: string[] = [];
  const patterns = assetBundlePatterns || ['**/*'];
  patterns.forEach((pattern: string) => {
    allFiles.push(...glob.sync(pattern, globOptions));
  });
  // If --include is passed in, only return files matching that pattern
  const included =
    options && options.include ? [...glob.sync(options.include, globOptions)] : allFiles;
  const toExclude = new Set();
  if (options && options.exclude) {
    glob.sync(options.exclude, globOptions).forEach(file => toExclude.add(file));
  }
  // If --exclude is passed in, filter out files matching that pattern
  const excluded = included.filter(file => !toExclude.has(file));
  const filtered = options && options.exclude ? excluded : included;
  return {
    allFiles: filterImages(allFiles, projectDir),
    selectedFiles: filterImages(filtered, projectDir),
  };
}

// Formats an array of files to include the project directory and filters out PNGs and JPGs.
function filterImages(files: string[], projectDir: string) {
  const regex = /\.(png|jpg|jpeg)$/;
  const withDirectory = files.map(file => `${projectDir}/${file}`.replace('//', '/'));
  const allImages = withDirectory.filter(file => regex.test(file.toLowerCase()));
  return allImages;
}

// Calculate SHA256 Checksum value of a file based on its contents
function calculateHash(filePath: string): string {
  const contents = readFileSync(filePath);
  return crypto
    .createHash('sha256')
    .update(contents)
    .digest('hex');
}

export type OptimizationOptions = {
  quality?: number;
  include?: string;
  exclude?: string;
  save?: boolean;
};

// Returns a boolean indicating whether or not there are assets to optimize
export async function isProjectOptimized(
  projectDir: string,
  options: OptimizationOptions
): Promise<boolean> {
  if (!fileExists(join(projectDir, '.expo-shared/assets.json'))) {
    return false;
  }
  const { selectedFiles } = await getAssetFilesAsync(projectDir, options);
  const { assetInfo } = await readAssetJsonAsync(projectDir);

  for (const file of selectedFiles) {
    const hash = calculateHash(file);
    if (!assetInfo[hash]) {
      return false;
    }
  }

  return true;
}

export async function optimizeAsync(
  projectRoot: string = './',
  options: OptimizationOptions = {}
): Promise<void> {
  console.log();
  console.log(chalk.bold`\u203A Optimizing assets...`);

  const { assetJson, assetInfo } = await readAssetJsonAsync(projectRoot);
  // Keep track of which hash values in assets.json are no longer in use
  const outdated = new Set<string>();
  for (const fileHash in assetInfo) outdated.add(fileHash);

  let totalSaved = 0;
  const { allFiles, selectedFiles } = await getAssetFilesAsync(projectRoot, options);
  const hashes: { [filePath: string]: string } = {};
  // Remove assets that have been deleted/modified from assets.json
  allFiles.forEach(filePath => {
    const hash = calculateHash(filePath);
    if (assetInfo[hash]) {
      outdated.delete(hash);
    }
    hashes[filePath] = hash;
  });
  outdated.forEach(outdatedHash => {
    delete assetInfo[outdatedHash];
  });

  const { include, exclude, save } = options;
  const quality = options.quality == null ? 80 : options.quality;

  const images = include || exclude ? selectedFiles : allFiles;

  for (const image of images) {
    const hash = hashes[image];
    if (assetInfo[hash]) {
      continue;
    }

    if (!(await isAvailableAsync())) {
      console.log(
        chalk.bold.red(
          `\u203A Cannot optimize images without sharp-cli.\n\u203A Run this command again after successfully installing sharp with \`${chalk.magenta`npm install -g sharp-cli`}\``
        )
      );
      return;
    }

    const { size: prevSize } = statSync(image);

    const newName = createNewFilename(image);
    const optimizedImage = await optimizeImageAsync(projectRoot, image, quality);

    const { size: newSize } = statSync(optimizedImage);
    const amountSaved = prevSize - newSize;
    if (amountSaved > 0) {
      await move(image, newName);
      await move(optimizedImage, image);
    } else {
      assetInfo[hash] = true;
      console.log(
        chalk.dim(
          amountSaved === 0
            ? ` \u203A Skipping: Original was identical in size.`
            : ` \u203A Skipping: Original was ${prettyBytes(amountSaved * -1)} smaller.`
        )
      );
      continue;
    }
    // Recalculate hash since the image has changed
    const newHash = calculateHash(image);
    assetInfo[newHash] = true;

    if (save) {
      if (hash === newHash) {
        console.log(
          chalk.gray(
            `\u203A Compressed asset ${image} is identical to the original. Using original instead.`
          )
        );
        unlinkSync(newName);
      } else {
        console.log(chalk.gray(`\u203A Saving original asset to ${newName}`));
        // Save the old hash to prevent reoptimizing
        assetInfo[hash] = true;
      }
    } else {
      // Delete the renamed original asset
      unlinkSync(newName);
    }
    if (amountSaved) {
      totalSaved += amountSaved;
      console.log(chalk.magenta(`\u203A Saved ${prettyBytes(amountSaved)}`));
    } else {
      console.log(chalk.gray(`\u203A Nothing to compress.`));
    }
  }
  console.log();
  if (totalSaved === 0) {
    console.log(chalk.yellow`\u203A All assets were fully optimized already.`);
  } else {
    console.log(
      chalk.bold(
        `\u203A Finished compressing assets. ${chalk.green(prettyBytes(totalSaved))} saved.`
      )
    );
  }
  assetJson.writeAsync(assetInfo);
}
