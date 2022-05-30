import { readFile } from "fs/promises";
import { basename } from "path";

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
  return a == b ? opts.fn() : opts.invert();
});
Handlebars.registerHelper("if_ne", (a, b, opts) => {
  return a != b ? opts.fn() : opts.invert();
});

const TypeAlias: Record<string, PromptType> = {
  string: "text",
  checkbox: "multiselect",
};

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

    Metalsmith(template)
      .clean(false)
      .source(".")
      .destination(to)
      .ignore([...(metaFile ? [metaFile] : [])])
      .use((files, metalsmith, callback) => {
        const localMetadata = metalsmith.metadata();

        // eslint-disable-next-line functional/no-loop-statement
        for (const [file, { contents }] of Object.entries(files)) {
          if (
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

          if (file === "_github") {
            // eslint-disable-next-line functional/immutable-data
            files[".github"] = files[file];
            // eslint-disable-next-line functional/immutable-data
            delete files[file];
          }

          if (file.endsWith(".hbs") || file.endsWith(".handlebars")) {
            // compile
            const compiled = Handlebars.compile(contents.toString())({
              extend,
              ...answers,
              localMetadata,
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
