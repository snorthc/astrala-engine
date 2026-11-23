// The three SPL Token helpers Astrala needs, written against @solana/web3.js directly. This replaces @solana/spl-token,
// whose dependency chain pulled in bigint-buffer (GHSA-3gc7-fjrx-p6mg). Classic Token program only, like the rest of the app.
import { PublicKey, TransactionInstruction, SystemProgram } from '@solana/web3.js'

export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')

export const getAssociatedTokenAddressSync = (mint: PublicKey, owner: PublicKey) =>
  PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID)[0]

/** Creates the recipient's token account if it doesn't exist yet; does nothing if it does. */
export const createAssociatedTokenAccountIdempotentInstruction = (payer: PublicKey, ata: PublicKey, owner: PublicKey, mint: PublicKey) =>
  new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true }, { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false }, { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }
    ],
    data: Buffer.from([1])
  })

/** TransferChecked (instruction 12): the token program refuses it if the mint or decimals don't match. */
export function createTransferCheckedInstruction(source: PublicKey, mint: PublicKey, dest: PublicKey, owner: PublicKey, amount: bigint, decimals: number) {
  if (amount < 0n || amount >= 1n << 64n) throw new Error('Amount out of range')
  const data = Buffer.alloc(10)
  data[0] = 12
  data.writeBigUInt64LE(amount, 1)
  data[9] = decimals
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true }, { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: dest, isSigner: false, isWritable: true }, { pubkey: owner, isSigner: true, isWritable: false }
    ],
    data
  })
}
