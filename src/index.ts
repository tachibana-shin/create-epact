#!/bin/env node

import { exec } from "child_process";
import { existsSync } from "fs";
import { readdir, rm } from "fs/promises";
import { join } from "path";

import axios from "axios";
import chalk from "chalk";
import { program } from "commander";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime.js";
import limax from "limax";
import ora from "ora";
import prompts from "prompts";

import buildTemplate from "./buildTemplate";
import downloadTemplate from "./helpers/downloadTemplate";
import DataRepo from "./type/DataRepo";

dayjs.extend(relativeTime);

program
  .description("Create by epact templates.")
  .argument(
    "[string]",
    "template name create project. (github.com/epact-templates)"
  )
  .option("-t, --template <string>", "template use create project")
  .action((projectName, { template }) => {
    createEpactProject(projectName, template).catch((err) => {
      if (err?.message) console.log(err.message);
    });
  })
  .parse();

async function getMetaTemplate(templateName?: string): Promise<DataRepo> {
  if (templateName) {
    if (templateName.includes("/") === false) {
      templateName = "epact-templates/" + templateName;
    }

    const spinFetchInfoRepo = ora(`Fetching meta repo ${templateName}`).start();
    try {
      const { data } = await axios.get<DataRepo>(
        `https://api.github.com/repos/${templateName}`
      );
      spinFetchInfoRepo.stop();

      return data;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      if (err?.response.status === 404) {
        spinFetchInfoRepo.fail(
          chalk.red(`Template "${templateName}" not found.`)
        );
        // eslint-disable-next-line functional/no-throw-statement
        throw void 0;
      } else {
        spinFetchInfoRepo.fail(err + "");
      }
    }
  }

  const spinner = ora("Fetching list templates from github...").start();

  const listTemplates = await axios
    .get<readonly DataRepo[]>(
      "https://api.github.com/users/epact-templates/repos"
    )
    .then((res) => {
      spinner.stop();
      return res.data.filter((repo) => {
        if (repo.topics.includes("epact-ignore")) return false;

        return true;
      });
    })
    .catch((err) => {
      spinner.fail("Fetch list templates failed: " + chalk.red(err.message));

      // eslint-disable-next-line functional/no-throw-statement
      throw err;
    });

  const { template } = await prompts({
    type: "select",
    name: "template",
    message: "Select a project template to start a new project",
    choices: listTemplates.map((infoRepo) => {
      return {
        title: chalk.blue(infoRepo.name),
        description: `${chalk.green(infoRepo.description)} (${chalk.red(
          dayjs().to(infoRepo.updated_at)
        )})`,
        value: infoRepo,
      };
    }),
  });

  return template;
}

async function createEpactProject(
  projectName?: string,
  templateName?: string
): Promise<void> {
  const cwd = process.cwd();

  if (!projectName) {
    projectName = await prompts({
      type: "text",
      name: "projectName",
      message: "Project name:",
      initial: "epact-project",
    }).then<string>(({ projectName }) => projectName);
  }
  const pathToProject = join(cwd, limax(projectName));

  if (
    existsSync(pathToProject) &&
    (await readdir(pathToProject).then((list) => list.length > 0))
  ) {
    const { acceptReplace = false } = await prompts({
      type: "confirm",
      name: "acceptReplace",
      message: `Target directory "${projectName}" is not empty. Remove existing files and continue?`,
    });

    if (!acceptReplace) {
      // eslint-disable-next-line functional/no-throw-statement
      throw new Error(chalk.red("✖") + " Operation cancelled");
    }

    await readdir(pathToProject).then((files) => {
      return Promise.all(
        files.map(async (name) => {
          const path = join(pathToProject, name);

          await rm(path, {
            recursive: true,
          });
        })
      );
    });
  }

  const template = await getMetaTemplate(templateName);
  // download template
  const spinDownload = ora(
    `Downloading template from "github/${template.name}"`
  ).start();
  const dirTemplate = await downloadTemplate(template, spinDownload);
  spinDownload.stop();

  const pkgManager = await getPkgManager();

  const [name, email] = await Promise.all([
    execPromise("git config --get user.name").catch(() => "unknown"),
    execPromise("git config --get user.email").catch(
      () => "privacy@github.com"
    ),
  ]);

  await buildTemplate(dirTemplate, pathToProject, {
    name: projectName,
    pkgName: limax(projectName),
    templateName: template.name,
    description: template.description,
    pkgManager,
    gitUser: {
      name,
      email,
      username:
        (await getUsernameGithub(email).catch(() => void 0)) ||
        name.replace(/\s/g, "-"),
    },
    FullYear: new Date().getFullYear(),
  });

  console.log(`Scaffolding project in ${pathToProject}`);

  console.log("\nDone. Now run:\n");
  console.log(`    cd ${limax(projectName)}\n`);
  console.log(`    ${pkgManager} install\n`);
}

function execPromise(shell: string) {
  return new Promise<string>((resolve, reject) => {
    exec(shell, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

async function existsCommand(cmd: string): Promise<boolean> {
  try {
    await execPromise(cmd);

    return true;
  } catch {
    return false;
  }
}
async function getPkgManager() {
  if (await existsCommand("pnpm -v")) return "pnpm";
  if (await existsCommand("yarn -v")) return "yarn";

  return "npm";
}
async function getUsernameGithub(email: string): Promise<string | void> {
  if (email.endsWith("@users.noreply.github.com")) {
    return email.match(/\d+\+([^@]+)@/)?.[1];
  }

  return await axios
    .get(`https://api.github.com/search/users?q=${email}`)
    .then(({ data }) => {
      return data.items[0]?.login;
    });
}
