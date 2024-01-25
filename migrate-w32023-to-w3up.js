#!/usr/bin/env node
import { W32023Upload, W32023UploadSummary, W32023UploadsFromNdjson } from "./w32023.js";
import * as Link from 'multiformats/link'
import { fileURLToPath } from 'url'
import fs from 'fs'
import { Readable } from 'node:stream'
import { toStoreAdd } from "./w32023-to-w3up.js";
import * as w3up from "@web3-storage/w3up-client"
import { parseArgs } from 'node:util'
import { Store, Upload } from '@web3-storage/capabilities'
import {DID} from "@ucanto/validator"
import { StoreConf } from '@web3-storage/access/stores/store-conf'
import { inspect } from 'util'

const isMain = (url, argv=process.argv) => fileURLToPath(url) === fs.realpathSync(argv[1])
if (isMain(import.meta.url, process.argv)) {
  main(process.argv).catch(error => console.error('error in main()', error))
}

async function main(argv) {
  const { values } = parseArgs({
    options: {
      space: {
        type: 'string',
        help: 'space DID to migrate to',
      }
    }
  })
  if ( ! values.space) throw new Error(`provide --space <space.did>`)
  const space = DID.match({ method: 'key' }).from(values.space)
  // @todo - we shouldn't need to reuse this store, though it's conventient for w3cli users.
  // instead, accept accept W3_PRINCIPAL and W3_PROOF env vars or flags 
  const store = new StoreConf({ profile: process.env.W3_STORE_NAME ?? 'w3cli' })
  const w3 = await w3up.create({ store })
  // @ts-expect-error _agent is protected property
  const access = w3._agent
  if (process.stdin.isTTY) {
    throw new Error(`pipe newline-delimited JSON uploads to stdin (e.g. from old \`w3 list --json\`)`)
  }
  const input = Readable.toWeb(process.stdin)
  const uploads = new W32023UploadsFromNdjson(input)
  for await (const upload of uploads) {
    for await (const add of toStoreAdd(upload)) {
      const storeAdd = {
        with: space,
        nb: add.nb,
      }
      const receipt = await access.invokeAndExecute(Store.add, storeAdd)
      if (receipt.out.ok) {
        console.warn('successfully invoked store/add with link=', add.nb.link)
      } else {
        console.warn('receipt.out', receipt.out)
        throw Object.assign(
          new Error(`failure invoking store/add`),
          {
            add,
            with: space,
            receipt: {
              ...receipt,
              out: receipt.out,
            },
          },
        )
      }
      let copiedCarTo
      // we know receipt indicated successful store/add.
      // now let's upload the car bytes if the response hints we should
      // @ts-expect-error ok type is {} but 'status' should be there or its ok if not
      switch (receipt.out.ok.status) {
        case "done":
          console.warn(`store/add ok indicates car ${add.part} was already in w3up`)
          break;
        case "upload": {
          // we need to upload car bytes
          const carResponse = await fetch(add.partUrl)
          // fetch car bytes
          /** @type {any} */
          const storeAddSuccess = receipt.out.ok
  
          if (carResponse.status !== 200) {
            throw Object.assign(
              new Error(`unexpected non-200 response status code when fetching car from w3s.link`),
              { part: add.part, url: add.partUrl, response: carResponse },
            )
          }
          // carResponse has status 200
          if (carResponse.headers.has('content-length')) {
            console.warn(`car ${add.part} has content-length`, carResponse.headers.get('content-length'))
          }
          console.warn(`piping CAR bytes from ${add.partUrl} to url from store/add response "${storeAddSuccess.url}"`)
          const sendCarRequest = new Request(
            storeAddSuccess.url,
            {
              method: 'PUT',
              mode: 'cors',
              headers: storeAddSuccess.headers,
              body: carResponse.body,
              redirect: 'follow',
              // @ts-ignore
              duplex: 'half' 
            }
          )
          const sendToPresignedResponse = await fetch(sendCarRequest)
          // ensure was 2xx, otherwise throw because something unusual happened
          if ( ! (200 <= sendToPresignedResponse.status && sendToPresignedResponse.status < 300)) {
            console.warn('unsuccessful sendToPresignedResponse', sendToPresignedResponse)
            throw Object.assign(
              new Error(`error sending car bytes to url from store/add response`), {
                response: sendToPresignedResponse,
              }
            )
          }
          copiedCarTo = {
            request: sendCarRequest,
            response: sendToPresignedResponse,
          }
          break;
        }
        default:
          console.warn('unexpected store/add ok.status', receipt.out.ok)
          // @ts-ignore
          throw new Error(`unexpected store/add ok.status: ${receipt.out.ok.status}`)
          // next part
          continue
      }
      // it's been added to the space. log that
      console.log(JSON.stringify({
        type: 'Add',
        attributedTo: access.issuer.did(),
        source: new W32023UploadSummary(upload),
        object: {
          type: 'car',
          cid: add.nb.link.toString(),
          size: add.nb.size.toString(),
          ...(copiedCarTo && {
            copy: {
              request: {
                url: copiedCarTo.request.url.toString(),
                method: copiedCarTo.request.method.toString(),
                headers: copiedCarTo.request.headers,
              },
              response: {
                status: copiedCarTo.response.status,
              }
            }
          })
        },
        target: {
          type: 'Space',
          id: space,
        },
        invocation: storeAdd,
        receipt: {
          cid: receipt.root.cid.toString(),
          out: receipt.out,
        },
      }, undefined, 2))
    }
    // store/add is done for upload
    // need to do an upload/add
    const shards = upload.parts.map(c => Link.parse(c))
    const root = Link.parse(upload.cid)
    const uploadAddReceipt = await access.invokeAndExecute(Upload.add, {
      with: space,
      nb: {
        root,
        // @ts-expect-error: Link.parse is generic link but shards wants CAR links type
        shards,
      }
    })
    if ( ! uploadAddReceipt.out.ok) {
      throw Object.assign(new Error(`failure result from upload/add invocation`), {
        result: uploadAddReceipt,
        out: uploadAddReceipt.out,
      })
    }
    console.log(JSON.stringify({
      type: 'Add',
      attributedTo: access.issuer.did(),
      source: new W32023UploadSummary(upload),
      object: {
        type: 'Upload',
        root,
        shards,
      },
      target: {
        type: 'Space',
        id: space,
      },
      receipt: {
        cid: uploadAddReceipt.root.cid.toString(),
        out: uploadAddReceipt.out,
      },
    }, undefined, 2))
  }
}
