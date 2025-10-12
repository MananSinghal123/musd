import { ethers } from "hardhat"

async function main() {
  const network = await ethers.provider.getNetwork()
  console.log("Chain ID:", network.chainId)
  console.log("Block number:", await ethers.provider.getBlockNumber())

  const [deployer] = await ethers.getSigners()
  console.log("Deployer address:", deployer.address)
  console.log(
    "Deployer balance:",
    ethers.formatEther(await ethers.provider.getBalance(deployer.address)),
  )
}

main().catch(console.error)
