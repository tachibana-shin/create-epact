import { existsSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import os from "os";
import { join } from "path";

import axios from "axios";
import download from "download";
import { Ora } from "ora";

import DataRepo from "../type/DataRepo";

export default async function downloadTemplate(repo: DataRepo, spinner: Ora) {
  // eslint-disable-next-line functional/immutable-data
  spinner.text = "Get SHA last commit...";
  const {
    data: { sha },
  } = await axios
    .get(repo.commits_url.replace("{/sha}", `/${repo.default_branch}`))
    .catch(() => ({ data: null }));

  const homedir = os.homedir();
  const pathToDir = join(homedir, ".epact-templates");
  const pathToTempl = join(pathToDir, repo.name);
  const pathMetaJson = join(pathToDir, "metadata.json");

  // eslint-disable-next-line functional/immutable-data
  spinner.text = "Checking SHA...";
  const metadata: Record<string, string> = await readFile(pathMetaJson, "utf8")
    .then((data) => JSON.parse(data))
    .catch(() => ({}));

  if (existsSync(pathToTempl)) {
    if (metadata[repo.name.toLocaleLowerCase()] === sha) {
      spinner.info("Nothing change. Use template from local.");
      return pathToTempl;
    }
  }

  await mkdir(pathToDir, {
    recursive: true,
  });

  await download(
    `${repo.html_url}/archive/refs/heads/${repo.default_branch}.zip`,
    pathToTempl,
    {
      extract: true,
      decompress: true,
      strip: 1,
      headers: {
        accept: "application/zip",
      },
    }
  );

  // eslint-disable-next-line functional/immutable-data
  metadata[repo.name.toLocaleLowerCase()] = sha;

  await writeFile(pathMetaJson, JSON.stringify(metadata), "utf8");

  return pathToTempl;
}
