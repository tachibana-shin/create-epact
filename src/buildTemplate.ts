import { readFile } from "fs/promises";
import { basename, join, relative } from "path";

import chalk from "chalk";
import Handlebars from "handlebars";
import JoyCon from "joycon";
import Metalsmith from "metalsmith";
import minimatch from "minimatch";
import ora from "ora";
import prompts, { PromptObject, PromptType } from "prompts";

const joy = new JoyCon();
const MetaFiles = [
  "meta.json",
  "metadata.json",
  "meta.js",
  "meta.ts",
  "metadata.js",
  "metadata.ts",
];

Handlebars.registerHelper("if_eq", (a, b, opts) => {
  return a == b ? opts.fn() : opts.inverse();
});
Handlebars.registerHelper("if_ne", (a, b, opts) => {
  return a != b ? opts.fn() : opts.inverse();
});

const TypeAlias: Record<string, PromptType> = {
  string: "text",
  checkbox: "multiselect",
};

const rParams = /(?:\{\{[^}]+\}\}){1}?/;

export default async function buildTemplate(
  template: string,
  to: string,
  extend: Record<string, unknown>
) {
  const metaFile = await joy.resolve(MetaFiles, template);

  const metadata: {
    // eslint-disable-next-line functional/prefer-readonly-type
    prompts?: Record<string, Omit<PromptObject, "name">>;
    // eslint-disable-next-line functional/prefer-readonly-type
    filters?: Record<string, string>;
    // eslint-disable-next-line functional/prefer-readonly-type
    description?: string;
  } = metaFile
    ? metaFile.endsWith(".json")
      ? await readFile(metaFile, "utf8")
          .then((data) => JSON.parse(data))
          .catch(() => ({}))
      : await joy.load([metaFile]).then(({ data }) => data)
    : {};

  const answers = await prompts(
    Object.entries(metadata.prompts || {}).map(([name, opts]) => {
      return {
        ...opts,
        type: opts.type ? TypeAlias[opts.type as string] ?? opts.type : "text",
        name,
        initial:
          name === "author"
            ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
              `${(extend.gitUser as any).name}<${
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (extend.gitUser as any).email
              }>`
            : void 0,
      };
    })
  );

  // eslint-disable-next-line functional/prefer-readonly-type
  const ignore: string[] = [];

  const nils = Object.fromEntries(
    Object.keys(metadata.prompts || {}).map((name) => [name, null])
  );
  // eslint-disable-next-line functional/no-loop-statement
  for (const [match, regular] of Object.entries(metadata.filters || {})) {
    try {
      if (
        new Function("props", `with(props) { return ${regular} }`)({
          ...nils,
          ...answers,
        })
      ) {
        // eslint-disable-next-line functional/immutable-data
        ignore.push(match);
      }
    } catch (err) {
      console.error(
        chalk.red(
          "Error when evaluating filter condition: " + regular + "\n " + err
        )
      );
    }
  }

  return new Promise<void>((resolve, reject) => {
    const spinRender = ora(
      `Rendering project from template "${basename(template)}"`
    ).start();

    const metaFileBasename = metaFile ? basename(metaFile) : "";

    Metalsmith(template)
      .clean(false)
      .source(".")
      .destination(to)
      .use((files, metalsmith, callback) => {
        const localMetadata = metalsmith.metadata();

        // eslint-disable-next-line functional/no-loop-statement, functional/no-let, prefer-const
        for (let [file, { contents }] of Object.entries(files)) {
          if (
            file === metaFileBasename ||
            ignore.some((match) =>
              minimatch(file, match, {
                dot: true,
              })
            )
          ) {
            // eslint-disable-next-line functional/immutable-data
            delete files[file];

            continue;
          }

          if (file.startsWith("_github/")) {
            const newFile = join(".github", relative("_github", file));
            // eslint-disable-next-line functional/immutable-data
            files[newFile] = files[file];
            // eslint-disable-next-line functional/immutable-data
            delete files[file];
            file = newFile;
          }

          if (rParams.test(file)) {
            // parse
            const newFile = Handlebars.compile(file)({
              ...extend,
              ...answers,
              localMetadata,
              description: metadata.description ?? extend.description,
            })

            // eslint-disable-next-line functional/immutable-data
            files[newFile] = files[file];
            // eslint-disable-next-line functional/immutable-data
            delete files[file];
            file = newFile;
          }

          if (file.endsWith(".hbs") || file.endsWith(".handlebars")) {
            // compile
            spinRender.info(chalk.gray("render file: " + file));

            const compiled = Handlebars.compile(contents.toString())({
              ...extend,
              ...answers,
              localMetadata,
              description: metadata.description ?? extend.description,
            });

            // eslint-disable-next-line functional/immutable-data
            files[file].contents = Buffer.from(compiled);
            // eslint-disable-next-line functional/immutable-data
            files[file.replace(/\.(?:hbs|handlebars)$/, "")] = files[file];
            // eslint-disable-next-line functional/immutable-data
            delete files[file];
          }
        }

        callback(null, files, metalsmith);
      })
      .build((err) => {
        if (err) {
          reject(err);
          spinRender.fail(err + "");
        } else {
          resolve();
          spinRender.stop();
        }
      });
  });
}
