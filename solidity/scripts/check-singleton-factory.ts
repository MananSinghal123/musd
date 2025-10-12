import { ethers } from "hardhat"
import { singletonFactoryAddress } from "../helpers/erc2470/singleton-factory"

async function main() {
  console.log("Checking singleton factory at:", singletonFactoryAddress)

  const code = await ethers.provider.getCode(singletonFactoryAddress)
  console.log("Code exists:", code !== "0x" && code !== "0x0")
  console.log("Code length:", code.length)

  if (code === "0x" || code === "0x0") {
    console.log("Singleton factory is not deployed on this network")
  } else {
    console.log("Singleton factory is already deployed")
  }
}

main().catch(console.error)
