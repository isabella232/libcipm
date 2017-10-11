'use strict'

const BB = require('bluebird')

const fixtureHelper = require('../lib/fixtureHelper.js')
const fs = BB.promisifyAll(require('fs'))
const path = require('path')
const requireInject = require('require-inject')
const Tacks = require('tacks')
const test = require('tap').test

const Dir = Tacks.Dir
const File = Tacks.File

let extract = () => {}
const pkgName = 'hark-a-package'
const pkgVersion = '1.0.0'
const writeEnvScript = process.platform === 'win32'
                     ? 'echo %npm_lifecycle_event% > %npm_lifecycle_event%'
                     : 'echo $npm_lifecycle_event > $npm_lifecycle_event'

const prefix = require('../lib/test-dir')(__filename)

const Installer = requireInject('../../index.js', {
  '../../lib/extract': {
    startWorkers () {},
    stopWorkers () {},
    child () {
      return extract.apply(null, arguments)
    }
  }
})

test('throws error when no package.json is found', t => {
  const fixture = new Tacks(Dir({
    'index.js': File('var a = 1')
  }))
  fixture.create(prefix)

  return new Installer({prefix}).run().catch(err => {
    t.equal(err.code, 'ENOENT')
  })
})

test('throws error when no package-lock nor shrinkwrap is found', t => {
  const fixture = new Tacks(Dir({
    'package.json': File({
      name: pkgName,
      version: pkgVersion
    })
  }))
  fixture.create(prefix)

  return new Installer({prefix}).run().catch(err => {
    t.equal(err.message, 'cipm can only install packages with an existing package-lock.json or npm-shrinkwrap.json with lockfileVersion >= 1. Run an install with npm@5 or later to generate it, then try again.')
  })
})

test('throws error when package.json and package-lock.json do not match', t => {
  const fixture = new Tacks(Dir({
    'package.json': File({
      name: pkgName,
      version: pkgVersion,
      dependencies: { a: '1' }, // should generate error
      optionalDependencies: { b: '2' } // should generate warning
    }),
    'package-lock.json': File({
      version: pkgVersion + '-0',
      dependencies: {},
      lockfileVersion: 1
    })
  }))
  fixture.create(prefix)

  return new Installer({prefix}).run().catch(err => {
    t.match(err.message, 'cipm can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync')
  })
})

test('throws error when old shrinkwrap is found', t => {
  const fixture = new Tacks(Dir({
    'package.json': File({
      name: pkgName,
      version: pkgVersion
    }),
    'npm-shrinkwrap.json': File({})
  }))
  fixture.create(prefix)

  return new Installer({prefix}).run().catch(err => {
    t.equal(err.message, 'cipm can only install packages with an existing package-lock.json or npm-shrinkwrap.json with lockfileVersion >= 1. Run an install with npm@5 or later to generate it, then try again.')
  })
})

test('handles empty dependency list', t => {
  const fixture = new Tacks(Dir({
    'package.json': File({
      name: pkgName,
      version: pkgVersion
    }),
    'package-lock.json': File({
      dependencies: {},
      lockfileVersion: 1
    })
  }))
  fixture.create(prefix)

  return new Installer({prefix}).run().then(details => {
    t.equal(details.pkgCount, 0)
  })
})

test('handles dependency list with only shallow subdeps', t => {
  const fixture = new Tacks(Dir({
    'package.json': File({
      name: pkgName,
      version: pkgVersion,
      dependencies: {
        'a': '^1'
      }
    }),
    'package-lock.json': File({
      dependencies: {
        a: {
          version: '1.1.1'
        }
      },
      lockfileVersion: 1
    })
  }))
  fixture.create(prefix)

  const aContents = 'var a = 1;'

  extract = (name, child, childPath, opts) => {
    const files = new Tacks(Dir({
      'package.json': File({
        name: pkgName,
        version: pkgVersion
      }),
      'index.js': File(aContents)
    }))
    files.create(childPath)
  }

  return new Installer({prefix}).run().then(details => {
    t.equal(details.pkgCount, 1)
    const modPath = path.join(prefix, 'node_modules', 'a')
    return fs.readFileAsync(path.join(modPath, 'index.js'), 'utf8')
  }).then(extractedContents => {
    t.equal(extractedContents, aContents, 'extracted data matches')
  })
})

test('handles dependency list with only deep subdeps', t => {
  const fixture = new Tacks(Dir({
    'package.json': File({
      name: pkgName,
      version: pkgVersion,
      dependencies: {
        a: '^1'
      }
    }),
    'package-lock.json': File({
      dependencies: {
        a: {
          version: '1.1.1',
          requires: {
            b: '2.2.2'
          },
          dependencies: {
            b: {
              version: '2.2.2'
            }
          }
        }
      },
      lockfileVersion: 1
    })
  }))
  fixture.create(prefix)

  const aContents = 'var a = 1;'
  const bContents = 'var b = 2;'

  extract = (name, child, childPath, opts) => {
    const files = new Tacks(Dir({
      'package.json': File({
        name: name,
        version: child.version
      }),
      'index.js': File(name === 'a' ? aContents : bContents)
    }))
    files.create(childPath)
  }

  return new Installer({prefix}).run().then(details => {
    t.equal(details.pkgCount, 2)
    return BB.join(
      fs.readFileAsync(
        path.join(prefix, 'node_modules', 'a', 'index.js'),
        'utf8'
      ),
      fs.readFileAsync(
        path.join(prefix, 'node_modules', 'a', 'node_modules', 'b', 'index.js'),
        'utf8'
      ),
      (a, b) => {
        t.equal(a, aContents, 'first-level dep extracted correctly')
        t.equal(b, bContents, 'nested dep extracted correctly')
      }
    )
  })
})

test('runs lifecycle hooks of packages with env variables', t => {
  const originalConsoleLog = console.log
  console.log = () => {}

  const fixture = new Tacks(Dir({
    'package.json': File({
      name: pkgName,
      version: pkgVersion,
      scripts: {
        preinstall: writeEnvScript,
        install: writeEnvScript,
        postinstall: writeEnvScript,
        prepublish: writeEnvScript,
        prepare: writeEnvScript
      },
      dependencies: {
        a: '^1'
      }
    }),
    'package-lock.json': File({
      dependencies: {
        a: { version: '1.0.0' }
      },
      lockfileVersion: 1
    })
  }))
  fixture.create(prefix)

  extract = (name, child, childPath, opts) => {
    const files = new Tacks(Dir({
      'package.json': File({
        name: 'a',
        version: '1.0.0',
        scripts: {
          preinstall: writeEnvScript,
          install: writeEnvScript,
          postinstall: writeEnvScript,
          prepublish: writeEnvScript,
          prepare: writeEnvScript
        }
      })
    }))
    files.create(childPath)
  }

  return new Installer({prefix}).run().then(details => {
    t.equal(details.pkgCount, 1)
    t.match(fixtureHelper.read(prefix, 'preinstall'), 'preinstall')
    t.match(fixtureHelper.read(prefix, 'install'), 'install')
    t.match(fixtureHelper.read(prefix, 'postinstall'), 'postinstall')
    t.match(fixtureHelper.read(prefix, 'prepublish'), 'prepublish')
    t.match(fixtureHelper.read(prefix, 'prepare'), 'prepare')
    t.match(fixtureHelper.read(path.join(prefix, 'node_modules', 'a'), 'preinstall'), 'preinstall')
    t.match(fixtureHelper.read(path.join(prefix, 'node_modules', 'a'), 'install'), 'install')
    t.match(fixtureHelper.read(path.join(prefix, 'node_modules', 'a'), 'postinstall'), 'postinstall')
    t.ok(fixtureHelper.missing(path.join(prefix, 'node_modules', 'a'), 'prepublish'), 'prepublish not run on deps')
    t.ok(fixtureHelper.missing(path.join(prefix, 'node_modules', 'a'), 'prepare'), 'prepare not run on deps')

    fixtureHelper.teardown()
    console.log = originalConsoleLog
  })
})

test('skips lifecycle scripts with ignoreScripts is set', t => {
  const originalConsoleLog = console.log
  console.log = () => {}

  const prefix = fixtureHelper.write(pkgName, {
    'package.json': {
      name: pkgName,
      version: pkgVersion,
      dependencies: { a: '^1' },
      scripts: {
        preinstall: writeEnvScript,
        install: writeEnvScript,
        postinstall: writeEnvScript,
        prepublish: writeEnvScript,
        prepare: writeEnvScript
      }
    },
    'package-lock.json': {
      dependencies: {
        a: { version: '1.0.0' }
      },
      lockfileVersion: 1
    }
  })
  const opts = {
    ignoreScripts: true,
    prefix: prefix
  }

  extract = fixtureHelper.getWriter(pkgName, {
    '/node_modules/a': {
      'package.json': {
        name: 'a',
        version: '1.0.0',
        scripts: {
          preinstall: writeEnvScript,
          install: writeEnvScript,
          postinstall: writeEnvScript,
          prepublish: writeEnvScript,
          prepare: writeEnvScript
        }
      }
    }
  })

  return new Installer(opts).run().then(details => {
    t.equal(details.pkgCount, 1)
    t.ok(fixtureHelper.missing(prefix, 'preinstall'))
    t.ok(fixtureHelper.missing(prefix, 'install'))
    t.ok(fixtureHelper.missing(prefix, 'postinstall'))
    t.ok(fixtureHelper.missing(prefix, 'prepublish'))
    t.ok(fixtureHelper.missing(prefix, 'prepare'))
    t.ok(fixtureHelper.missing(path.join(prefix, 'node_modules', 'a'), 'preinstall'))
    t.ok(fixtureHelper.missing(path.join(prefix, 'node_modules', 'a'), 'install'))
    t.ok(fixtureHelper.missing(path.join(prefix, 'node_modules', 'a'), 'postinstall'))
    t.ok(fixtureHelper.missing(path.join(prefix, 'node_modules', 'a'), 'prepublish'))
    t.ok(fixtureHelper.missing(path.join(prefix, 'node_modules', 'a'), 'prepare'))

    fixtureHelper.teardown()
    console.log = originalConsoleLog
  })
})

test('handles JSON docs that contain a BOM', t => {
  t.plan(2)
  const Installer = requireInject('../../index.js', {/* just don't want to cache */})
  const bomJSON = 'package-json-with-bom.json'
  const bomJSONDir = path.resolve(__dirname, '../lib')
  const actualJSON = {
    name: 'strong-spawn-npm',
    version: '1.0.0',
    description: 'Reliably spawn npm™ on any platform',
    homepage: 'https://github.com/strongloop/strong-spawn-npm'
  }
  // ensure that the file does indeed fail to be parsed by JSON.parse
  t.throws(() => JSON.parse(fs.readFileSync(path.join(bomJSONDir, bomJSON), 'utf8')),
           {message: 'Unexpected token \uFEFF'})
  return Installer._readJson(bomJSONDir, bomJSON).then(obj => t.match(obj, actualJSON))
})
