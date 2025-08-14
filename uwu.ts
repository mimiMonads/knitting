import { bench , run} from "mitata";


const str = "helloWorld".repeat(1000);
bench (() => {
  const need = Buffer.byteLength(str)
})
bench (() => {
  const need = (str.length * 4)
})

console.log(Buffer.byteLength(("😀")))
run()