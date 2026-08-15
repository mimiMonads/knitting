import { createPool , isMain } from "knitting"

export const hello = (name: string) => "Hello " + name

using pool = createPool({
    worker: {
        runtime: "compiled",
        processRuntime: "porffor"
    }
})({hello})

if (isMain) console.log(await pool.call.hello("World!"))