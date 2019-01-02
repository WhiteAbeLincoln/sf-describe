import { promisify } from 'util'
import {
  readdir,
  readFile as readfile,
  mkdir,
  writeFile as writefile,
  stat as Stat,
  Stats,
} from 'fs'
import { resolve } from 'path'
import { DescribeSObjectResult, Connection } from 'jsforce'

type Refinement<A, B extends A> = (a: A) => a is B
type Predicate<A> = (a: A) => boolean
type Reducer<B, A, C = B> = (acc: B, curr: A) => C

const mapT = <t1, t2>(fn: (a: t1) => t2) => <t3, t4>(
  step: Reducer<t3, t2, t4>,
): Reducer<t3, t1, t4> => (acc, curr) => step(acc, fn(curr))

// (t -> Bool) -> (p -> t -> p) -> p -> t -> p
const filterT = <t, u extends t = t>(
  predicate: Refinement<t, u> | Predicate<t>,
) => <p>(step: Reducer<p, u>): Reducer<p, t> => (acc, curr) =>
  predicate(curr) ? step(acc, curr) : acc

const accumulate = <T>(acc: T[], curr: T) => {
  acc.push(curr)
  return acc
}

const readDir = promisify(readdir)
const readFile = promisify(readfile)
const writeFile = promisify(writefile)
const mkDir = promisify(mkdir)
const stat = promisify(Stat)

type StatPair = [string, Stats]

const statFilterMap = (pred: (s: StatPair) => boolean) =>
  filterT(pred)(
    mapT((s: StatPair) => s[0])(accumulate as Reducer<string[], string>),
  )

const getStatPair = (f: string) => stat(f).then(s => [f, s] as [string, Stats])
const getFiles = (sp: ReadonlyArray<StatPair>) =>
  sp.reduce(statFilterMap(s => s[1].isFile()), [] as string[])

const getDirectories = (sp: ReadonlyArray<StatPair>) =>
  sp.reduce(statFilterMap(s => s[1].isDirectory()), [] as string[])

const flatten = <A>(ffa: A[][]): A[] => {
  let rLen = 0
  const len = ffa.length
  for (let i = 0; i < len; i++) {
    rLen += ffa[i].length
  }
  const r = Array(rLen)
  let start = 0
  for (let i = 0; i < len; i++) {
    const arr = ffa[i]
    const l = arr.length
    for (let j = 0; j < l; j++) {
      r[j + start] = arr[j]
    }
    start += l
  }
  return r
}

export type DescribePromiseList = Array<Promise<DescribeSObjectResult>>

/**
 * Reads describe files and parses to an object
 * @param paths A list of json files or directories
 * @returns A promise for an array of promises which resolve to SObjectMetadata objects
 */
export async function importDescribeFiles(
  ...paths: string[]
): Promise<DescribePromiseList> {
  const statPairs = await Promise.all(
    paths.map(p => resolve(p)).map(getStatPair),
  )

  const files = getFiles(statPairs)
  const dirs = getDirectories(statPairs)

  const subFiles = await Promise.all(
    dirs.map(d =>
      readDir(d)
        .then(fs => fs.map(f => resolve(d, f)).map(getStatPair))
        .then(sps => Promise.all(sps))
        .then(getFiles),
    ),
  ).then(flatten)

  return [...files, ...subFiles].map(file =>
    readFile(file, 'utf8').then(s => JSON.parse(s)),
  )
}

/**
 * Writes salesforce describe objects as json files
 * @param describes An array of SObjectMetadata objects
 * @param directory Directory to write describe files to
 * @returns An array of promises which resolve to the filename when a file is written
 */
export async function writeDescribeFiles(
  describes: ReadonlyArray<DescribeSObjectResult>,
  directory: string,
): Promise<Array<Promise<string>>> {
  try {
    // tslint:disable-next-line:no-expression-statement
    await mkDir(directory)
  } catch (err) {
    if (err.code !== 'EEXIST') {
      throw err
    }
  }

  return describes.map(o => {
    const name = `${directory}/${o.name}.desc.json`
    return writeFile(name, JSON.stringify(o)).then(() => name)
  })
}

export { Connection }

/**
 * Describes the salesforce objects of an instance
 * @param conn An authenticated JSForce connection object
 * @returns An array of promises which resolve to SObjectMetadata objects
 */
export async function describeSalesforceObjects(
  conn: Connection,
): Promise<DescribePromiseList> {
  const global = await conn.describeGlobal()
  return global.sobjects.map(o => conn.sobject(o.name).describe())
}
