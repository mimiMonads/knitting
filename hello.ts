import { createPool , isMain } from "knitting"

export const hello = (name: string) => "Hello " + name

using pool = createPool({})({hello})

if (isMain) console.log(await pool.call.hello("World!"))