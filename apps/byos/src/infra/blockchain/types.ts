/** Error from escrow debit operations — always transient (retry later). */
export interface DebitError {
	message: string;
}
