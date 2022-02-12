#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const {
  runok,
  tasks: { git, exec },
  chdir,
} = require('runok')
const axios = require('axios');
const Analyzer = require('check-tests/src/analyzer')
const glob = require('glob')

const testFrameworks = ['qunit', 'mocha', 'jest', 'cypress.io', 'codeceptjs', 'jasmine', 'tap']

const testDirs = ['cypress', '__tests__', 'test', 'tests', 'specs', 'spec', 'integration-tests', 'e2e-tests', 'unit-tests']

const testPattern = '**/*[._-]{test,spec,unittest,unit}.{ts,js}'

const tmpDir = path.join(__dirname, 'repos')

module.exports = {
  async buildRepositories() {
    // clone repo
    await git.clone('https://github.com/awesometested/list', 'list', {
      shallow: true,
    })
    // go through files
    const files = [] // get list of files

    for (const file of files) {
      process.cwd(path.join(__dirname, 'list'))
      try {
        const data = JSON.parse(fs.readFileSync(file))
        console.log('Processing', file)
        console.log('Repository:', data.repo)

        const repoPath = file + '_cloned'
        await git.clone(data.repo, repoPath, { shallow: true })

        this.analyzeFile(file, repoPath)
      } catch (err) {
        console.error(err)
      }
    }
  },

  async repoTrending(period = 'daily') {
    const repos = await axios.get('https://trendings.herokuapp.com/repo?lang=javascript&since='+period)
    console.log("Adding repos ", repos.data.items.length)
    const success = []
    for (let item of repos.data.items) {
      try {
        process.cwd(__dirname);
        await this.repoAdd(item.repo);
        await this.analyzeTests(item.repo);
        success.push(item.repo);
      } catch (err) {
        console.log(`Repo ${item.repo} is ignored`, err);
        continue;
      }
    }
    console.log('SUCCESSFULLY PARSED', success);
  },

  async repoPopular() {
    for (let i = 1; i < 200; i++) {
      const repos = await axios.get('https://api.github.com/search/repositories', {
        params: {
          page: i,
          sort: 'stars',
          order: 'desc',
          q: 'language:typescript'
        }
      })
      console.log("Adding repos ", repos.data.items.length)
      // console.log(repos.data.items[0]);
      // return;
      const success = []
      for (let item of repos.data.items) {
        try {
          process.cwd(__dirname);
          await this.repoAdd(item.full_name);
          await this.analyzeTests(item.full_name);
          success.push(item.full_name);
        } catch (err) {
          console.log(`Repo ${item.full_name} is ignored`, err);
          continue;
        }
      }
      console.log('SUCCESSFULLY PARSED', success);

    }

  },

  async repoAdd(repo) {
    const dir = await ensureRepoDir(repo);

    const configs = [];
    // console.log('ADDED'); process.exit(1);

    let framework = null;

    const getDirectories = (source) =>
      fs
        .readdirSync(source, { withFileTypes: true })
        .filter((dirent) => dirent.isDirectory())
        .map((dirent) => dirent.name)

    const detectFwk = async (rootDir) => {
        let fwk = null
        let pattern = testPattern;

        const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json')))
        const deps = [
          ...Object.keys(pkg.dependencies || {}),
          ...Object.keys(pkg.devDependencies || {}),
        ]
        fwk = testFrameworks.filter((value) => deps.includes(value))[0]

        if (!fwk && framework) fwk = framework;
        if (!framework) framework = fwk;
        if (!fwk && !framework) return;

        const dirs = getDirectories(rootDir)
        let testDir = dirs.filter((d) => testDirs.includes(d))[0]

        // react
        if (!testDir && fs.existsSync(path.join(rootDir, 'src', '__tests__'))) {
          testDir = path.join('src', '__tests__');
        }
        // console.log(dirs);
        if (!testDir) return;


        let hasTypeScript = false
        if (glob.sync(path.join(rootDir, testDir, '*/**.ts'), { ignore: 'node_modules/**' }).length) {
          hasTypeScript = true
        }


        // no files found? Let's pick all js/ts files then!
        if (!glob.sync(path.join(rootDir, testDir, pattern), { ignore: 'node_modules/**' }).length) {
          pattern = '**/*.{js,ts,cjs,mjs}'
        }

        // avoid duplicate
        if (configs.filter(c => c.package === pkg.name && c.framework === fwk).length) return;

        configs.push({
          package: pkg.name,
          lang: hasTypeScript ? 'ts' : 'js',
          dir: path.join(rootDir, testDir).replace(dir + '/', ''),
          framework: fwk,
          pattern
        });
    }

    // detectFwk(dir);

    const packages = glob.sync(path.join(dir, '**', 'package.json'), { ignore: 'node_modules/**' })
    for (const package of packages) {
      if (path.dirname(package).includes('ode_modules')) continue;
      detectFwk(path.dirname(package));
    }

    branch = (await exec('git branch --show-current', { cwd: dir })).data.stdout.trim()

    const data = { repo, url: `https://github.com/${repo}`, branch, configs }

    if (!configs.length) {
      data.error = "Tests not detected"
    }

    fs.writeFileSync(repoFile(repo), JSON.stringify(data, null, 4));

    console.log(`${repo} analyzed and saved to ${repoFile(repo)}`)
  },

  async analyzeTests(repo) {
    const data = JSON.parse(fs.readFileSync(repoFile(repo)))

    if (!data.configs) throw new Error('Configs empty')

    const repoPath = await ensureRepoDir(repo)

    data.tests = []
    delete data.error;

    for (const conf of data.configs) {
      // not supported
      if (!['ts', 'js'].includes(conf.lang)) continue

      const testsPath = path.join(repoPath, conf.dir || '.')

      if (conf.framework == 'tap') conf.framework = 'jest';

      const analyzer = new Analyzer(conf.framework, testsPath)

      if (conf.lang === 'ts') {
        analyzer.withTypeScript()
      }

      if (conf.lang === 'js') {
        analyzer.addPlugin('@babel/plugin-syntax-jsx')
        analyzer.addPlugin('@babel/plugin-syntax-flow')
        analyzer.addPreset('@babel/preset-react')
        analyzer.addPreset('@babel/preset-flow')

        // analyzer.presets.push('@babel/preset-vue')
      }

      try {
        analyzer.analyze(conf.pattern || '')
      } catch (err) {
        console.log(err);
        data.error = err.message;
        fs.writeFileSync(outputFile(repo), JSON.stringify(data, null, 4))
        return;
      }
      const tests = analyzer.rawTests.flat()
      tests.forEach((t) => {
        t.dir = conf.dir
      })
      data.tests = data.tests.concat(tests)
    }

    if (!data.tests.length) {
      console.log(repo, 'no tests detected ')
      data.error = "No tests found";
      if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile(repo));
      // fs.writeFileSync(outputFile(repo), JSON.stringify(data, null, 4))
      return
    }
    console.log(repo, `${data.tests.length} tests found`)

    fs.writeFileSync(outputFile(repo), JSON.stringify(data))
  },

  async analyzeConfigs() {
    const success = []
    for (let file of glob.sync('configs/**.json')) {
      try {
        let data = JSON.parse(fs.readFileSync(file));
        await this.analyzeTests(data.repo);
        data = JSON.parse(fs.readFileSync(file));
        if (data.tests && data.tests.length > 0) success.push({ repo: data.repo, count: data.tests.length});
      } catch (err) {
        console.log('Ignoring', file, err)
      }
    }
    fs.writeFileSync(path.join(__dirname, 'output', 'list.json'), JSON.stringify(success, null, 4))
  },

  async updateList() {
    const success = [];
    for (let file of glob.sync('output/**.json', { ignore: 'list.json' })) {
      let data = JSON.parse(fs.readFileSync(file));
      if (data.tests && data.tests.length > 0) success.push({ repo: data.repo, count: data.tests.length});
    }
    fs.writeFileSync(path.join(__dirname, 'output', 'list.json'), JSON.stringify(success, null, 4))

  },

  async cleanConfigs() {
    const success = [];
    for (let file of glob.sync('configs/*.json')) {
      try {
        let outputFile = path.join(__dirname, 'output', path.basename(file));
        let data = JSON.parse(fs.readFileSync(file));
        // this.repoAdd(data.repo);
        if (!data.configs || data.configs.length < 1) {
          fs.unlinkSync(file);
          fs.unlinkSync(outputFile);
          continue;
        }

        // await this.analyzeTests(data.repo);
        delete data.error
        delete data.tests

        fs.writeFileSync(file, JSON.stringify(data, null, 4));

        let outputData = JSON.parse(fs.readFileSync(path.join(__dirname, 'output', path.basename(file))));
        if (!outputData.tests || !outputData.tests.length) {
          fs.unlinkSync(file);
          fs.unlinkSync(outputFile);
          continue
        }
        // data = JSON.parse(fs.readFileSync(file));

        // if (!data.error && data.tests) success.push({ repo: data.repo, count: data.tests.length});
      } catch (err) {
        console.log('Ignoring', file, err)
      }
    }
    // fs.writeFileSync('static/list.json', JSON.stringify(success, null, 4))
  },

  async fixPatterns() {
    const success = [];
    for (let file of glob.sync('output/*.json', { ignore: 'list.json' })) {
      try {
        let data = JSON.parse(fs.readFileSync(file));
        // console.log(data);
        if (!data.configs) continue;
        if (data.tests && data.tests.length) continue;
        if (!data.error) continue;

        const configFile = path.join('configs', path.basename(file));
        data = JSON.parse(fs.readFileSync(file));
        data.configs.forEach(c => c.pattern = '**/*.{js,ts}')
        fs.writeFileSync(configFile, JSON.stringify(data, null, 4));
        console.log('Fixed pattern for ', data.repo)
      } catch (err) {
        console.log('Failed fixing for ', data.repo)
      }
    }
    // this.analyzeConfigs();
    // this.updateList();
    // fs.writeFileSync('static/list.json', JSON.stringify(success, null, 4))
  },

  async analyzeRepos() {
    const success = [];
    for (let file of glob.sync(path.join(tmpDir, '*', 'package.json'))) {
      try {
        let data = JSON.parse(fs.readFileSync(file));
        await this.analyzeTests(data.repo);
        data = JSON.parse(fs.readFileSync(file));
        if (!data.error && data.tests) success.push({ repo: data.repo, count: data.tests.length});
      } catch (err) {
        console.log('Ignoring', file, err)
      }
    }
    fs.writeFileSync('output/list.json', JSON.stringify(success, null, 4))
  },


  syncList() {
    for (let file of glob.sync('output/*.json', { ignore: 'list.json' })) {
      if (fs.existsSync(path.join('configs', path.basename(file)))) return;

      const data = fs.readFileSync(file);
      delete data.error;
      delete data.tests;
      fs.writeFileSync(path.join('configs', path.basename(file)));
      console.log('Synchronized', path.basename(file));
    }
  }
}

function repoFile(repo) {
  return path.join(
    __dirname,
    'configs',
    (repo.replace('/', '__').replace('.', '_') + '.json').toLowerCase()
  )
}

function outputFile(repo) {
   return path.join(
    __dirname,
    'output',
    (repo.replace('/', '__').replace('.', '_') + '.json').toLowerCase()
  )
}

async function ensureRepoDir(repo) {
  const dir = path.join(tmpDir, repo.replace('/', '__').replace('.', '_'))

  if (!fs.existsSync(dir)) {
    await exec(`git clone https://github.com/${repo}.git ${dir} --depth=1`, { output: true })
  } else {
    try {
      await exec(`git pull --depth=1 --no-tags`, { cwd: dir });
    } catch (err) {
      // history issues
      await exec(`rm -rf ${dir}`)
      await exec(`git clone https://github.com/${repo}.git ${dir} --depth=1`, { output: true })
    }
  }
  if (!fs.existsSync(dir)) {
    throw new Error('Dir cant be created')
  }
  return dir
}

if (require.main === module) runok(module.exports)
