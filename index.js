const IPFS = require('ipfs')
const Repo = require('ipfs-repo')
const HookedDataStore = require('datastore-ipfs-ro-hook')
const Key = require('interface-datastore').Key
const ConcatStream = require('concat-stream')
const http = require('http')

const ETH_PROTOCOL = process.env.ETH_PROTOCOL || 'http'
const ETH_HOST = process.env.ETH_HOST || 'localhost'
const ETH_PORT = process.env.ETH_PORT || '5001'
const uriBase = `${ETH_PROTOCOL}://${ETH_HOST}:${ETH_PORT}/api/v0/block/get?arg=`

const repo = new Repo('./ipfs-repo')
const node = new IPFS({
  repo: repo,
  start: true,
})

node.on('ready', () => {
  // hacky late add to MountStore
  console.log(`Mounting Parity as data store: ${ETH_PROTOCOL}://${ETH_HOST}:${ETH_PORT}`)
  const dataStoreMount = {
    prefix: new Key('/blocks/'),
    datastore: new HookedDataStore(fetchByCid)
  }
  repo.store.mounts.unshift(dataStoreMount)
  setupHttpApi()
})

function fetchByCid(cid, cb) {
  const cidString = cid.toBaseEncodedString()
  const uri = uriBase + cidString
  http.get(uri, (res) => {
    res.pipe(ConcatStream((result) => {
      cb(null, result)
    }))
    res.once('error', cb)
  })
}

// Events

// node.on('ready', () => console.log('ready'))    // Node is ready to use when you first create it
// node.on('error', () => console.log('error')) // Node has hit some error while initing/starting

// node.on('init', () => console.log('init'))     // Node has successfully finished initing the repo
// node.on('start', () => console.log('start'))    // Node has started
// node.on('stop', () => console.log('stop'))     // Node has stopped


function setupHttpApi() {
  // const HttpAPI = require('ipfs/src/http-api')
  httpAPI = new HttpApiServer(node)
  httpAPI.start((err) => {
    if (err && err.code === 'ENOENT') {
      console.log('Error: no ipfs repo found in ' + repoPath)
      console.log('please run: jsipfs init')
      process.exit(1)
    }
    if (err) {
      throw err
    }
    console.log('Daemon is ready')
  })

  process.on('SIGINT', () => {
    console.log('Received interrupt signal, shutting down..')
    httpAPI.stop((err) => {
      if (err) {
        throw err
      }
      process.exit(0)
    })
  })
}

//
// Http API Server
//

const series = require('async/series')
const Hapi = require('hapi')
const errorHandler = require('ipfs/src/http-api/error-handler')
const multiaddr = require('multiaddr')
const setHeader = require('hapi-set-header')

function uriToMultiaddr (uri) {
  const ipPort = uri.split('/')[2].split(':')
  return `/ip4/${ipPort[0]}/tcp/${ipPort[1]}`
}

class HttpApiServer {

  constructor (node) {
    this.node = node
    this.log = console.log
    this.log.error = console.error
  }

  start (cb) {
    series([
      (cb) => {
        this.log('fetching config')
        this.node._repo.config.get((err, config) => {
          if (err) {
            return callback(err)
          }

          // CORS is enabled by default
          this.server = new Hapi.Server({
            connections: { routes: { cors: true } }
          })

          this.server.app.ipfs = this.node
          const api = config.Addresses.API.split('/')
          const gateway = config.Addresses.Gateway.split('/')

          // select which connection with server.select(<label>) to add routes
          this.server.connection({
            host: api[2],
            port: api[4],
            labels: 'API'
          })

          this.server.connection({
            host: gateway[2],
            port: gateway[4],
            labels: 'Gateway'
          })

          // Nicer errors
          errorHandler(this, this.server)

          // load routes
          // require('./routes')(this.server)
          require('ipfs/src/http-api/routes')(this.server)

          // Set default headers
          setHeader(this.server,
            'Access-Control-Allow-Headers',
            'X-Stream-Output, X-Chunked-Output, X-Content-Length')
          setHeader(this.server,
            'Access-Control-Expose-Headers',
            'X-Stream-Output, X-Chunked-Output, X-Content-Length')

          this.server.start(cb)
        })
      },
      (cb) => {
        const api = this.server.select('API')
        const gateway = this.server.select('Gateway')
        this.apiMultiaddr = multiaddr('/ip4/127.0.0.1/tcp/' + api.info.port)
        api.info.ma = uriToMultiaddr(api.info.uri)
        gateway.info.ma = uriToMultiaddr(gateway.info.uri)

        this.log('API is listening on: %s', api.info.ma)
        this.log('Gateway (readonly) is listening on: %s', gateway.info.ma)

        // for the CLI to know the where abouts of the API
        this.node._repo.setApiAddress(api.info.ma, cb)
      }
    ], cb)

    this.stop = (callback) => {
      this.log('stopping')
      series([
        (cb) => this.server.stop(cb),
        (cb) => this.node.stop(cb)
      ], (err) => {
        if (err) {
          this.log.error(err)
          this.log('There were errors stopping')
        }
        callback()
      })
    }
  }

}