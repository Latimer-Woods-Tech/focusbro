const FIELDS = ['source', 'campaign', 'content', 'challenge'];

function clean(value, name, required = false) {
  const text = String(value || '').trim().toLowerCase();
  if (required && !text) throw new Error(`--${name} is required`);
  if (!text) return '';
  if (text.length > 80) throw new Error(`--${name} must be 80 characters or fewer`);
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(text)) {
    throw new Error(`--${name} must use lowercase letters, numbers, dots, dashes, or underscores`);
  }
  return text;
}

export function buildGrowthLink(options = {}) {
  const url = new URL(options.base || 'https://focusbro.net/');
  for (const field of FIELDS) {
    const value = clean(options[field], field, field === 'source' || field === 'campaign');
    if (value) url.searchParams.set(`utm_${field}`, value);
  }
  return url.toString();
}

export function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const name = arg.slice(2);
    if (![...FIELDS, 'base'].includes(name)) throw new Error(`Unknown option: --${name}`);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`--${name} needs a value`);
    options[name] = value;
    i += 1;
  }
  return options;
}

const isCli = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isCli) {
  try {
    console.log(buildGrowthLink(parseArgs(process.argv.slice(2))));
  } catch (error) {
    console.error(`growth-link: ${error.message}`);
    process.exitCode = 1;
  }
}
