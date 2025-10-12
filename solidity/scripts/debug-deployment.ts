import { ethers } from "hardhat"
import { ensureSingletonFactory } from "../helpers/erc2470/singleton-factory"

async function main() {
  console.log("Testing TokenDeployer deployment simulation...")

  const [deployer] = await ethers.getSigners()
  console.log("Deployer:", deployer.address)

  const singletonFactory = await ensureSingletonFactory(deployer)
  console.log("Singleton factory address:", await singletonFactory.getAddress())

  const contractFactory = await ethers.getContractFactory(
    "TokenDeployer",
    deployer,
  )

  const creationCode = contractFactory.bytecode
  console.log("Creation code length:", creationCode.length)

  const salt = ethers.keccak256(
    ethers.toUtf8Bytes(
      "Bank on yourself. Bring everyday finance to your Bitcoin.",
    ),
  )
  console.log("Salt:", salt)

  // The initcode is the contract bytecode concatenated with the encoded constructor arguments.
  const initCode = creationCode + "" // No constructor args for TokenDeployer
  console.log("Init code length:", initCode.length)

  try {
    // Simulate contract deployment with SingletonFactory.
    console.log("Running staticCall simulation...")
    const contractAddress = await singletonFactory.deploy.staticCall(
      initCode,
      salt,
    )
    console.log("Simulated contract address:", contractAddress)

    if (contractAddress === ethers.ZeroAddress) {
      console.log("❌ Deployment simulation returned ZeroAddress!")

      // Check if contract already exists at this address
      const expectedAddress = ethers.getCreate2Address(
        await singletonFactory.getAddress(),
        salt,
        ethers.keccak256(initCode),
      )
      console.log("Expected CREATE2 address:", expectedAddress)

      const existingCode = await ethers.provider.getCode(expectedAddress)
      console.log(
        "Code already exists at expected address:",
        existingCode !== "0x" && existingCode !== "0x0",
      )
      console.log("Existing code length:", existingCode.length)
    } else {
      console.log("✅ Deployment simulation successful!")
    }
  } catch (error) {
    console.log("❌ Simulation failed with error:", error)
  }
}

main().catch(console.error)
