const { ethers } = require("hardhat")

async function main() {
  const [deployer] = await ethers.getSigners()
  console.log("Deployer address:", deployer.address)
  console.log("Network:", (await ethers.provider.getNetwork()).name)
  console.log("Chain ID:", (await ethers.provider.getNetwork()).chainId)

  // Get the TokenDeployer contract
  const tokenDeployerAddress = "0x9D7766bFaB27E986751767295973d4dc2FDC18b9"
  const tokenDeployer = await ethers.getContractAt(
    "TokenDeployer",
    tokenDeployerAddress,
  )

  // Check if token is already deployed
  try {
    const tokenAddress = await tokenDeployer.token()
    console.log("Token already deployed at:", tokenAddress)
    if (tokenAddress !== ethers.ZeroAddress) {
      console.log("MUSD token is already deployed! Skipping deployment.")
      return
    }
  } catch (error) {
    console.log("Error checking token address:", error.message)
  }

  // Get contract addresses from deployments
  const troveManagerAddr = "0xd3411d7775F6dD44B53744a5e3Bb160b3FF3e946"
  const stabilityPoolAddr = "0x1D5624feAC04c2928057C7cf1D877287665956EE"
  const borrowerOperationsAddr = "0x99c1Ec314b0d960718bA07b198c65fDf2b9Df32b"
  const interestRateManagerAddr = "0x368d4c5c2489CD6A47103a5912EC5deDB446e1C4"
  const rcoManagerAddr = "0xCe4563f1414e989079C837B10788227B6fF738e0"

  console.log("Contract addresses:")
  console.log("TroveManager:", troveManagerAddr)
  console.log("StabilityPool:", stabilityPoolAddr)
  console.log("BorrowerOperations:", borrowerOperationsAddr)
  console.log("InterestRateManager:", interestRateManagerAddr)
  console.log("ReversibleCallOptionManager:", rcoManagerAddr)

  try {
    // Try to call deployToken function
    console.log("Attempting to deploy MUSD token...")
    const tx = await tokenDeployer.deployToken(
      troveManagerAddr,
      stabilityPoolAddr,
      borrowerOperationsAddr,
      interestRateManagerAddr,
      rcoManagerAddr,
      { gasLimit: 5000000 },
    )

    console.log("Transaction hash:", tx.hash)
    await tx.wait()
    console.log("MUSD token deployed successfully!")

    const tokenAddress = await tokenDeployer.token()
    console.log("MUSD token address:", tokenAddress)
  } catch (error) {
    console.log("Error deploying token:", error.message)

    // Try to get more detailed error information
    try {
      await tokenDeployer.deployToken.staticCall(
        troveManagerAddr,
        stabilityPoolAddr,
        borrowerOperationsAddr,
        interestRateManagerAddr,
        rcoManagerAddr,
      )
    } catch (staticError) {
      console.log("Static call error:", staticError.message)
      if (staticError.data) {
        console.log("Error data:", staticError.data)
      }
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
