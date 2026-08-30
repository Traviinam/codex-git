export function createGitEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment = { ...source };
  for (const key of Object.keys(environment)) {
    if (key.startsWith('GIT_')) {
      delete environment[key];
    }
  }
  environment.GIT_OPTIONAL_LOCKS = '0';
  environment.LC_ALL = 'C';
  return environment;
}
