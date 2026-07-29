// Test the new repair function
const problematicJson = `{"evaluation_previous_goal": "成功打开了百度首页的新标签页。判定：成功","memory": "已打开百度首页 ( \`https://www.baidu.com/)，当前在第一步完成后的状态。需要在搜索框中输入\` "柯南\\"并执行搜索。","next_goal": "在百度搜索框中输入\\"柯南\\"文本。","action": {"input_text": {"index": 11,"text": "柯南"}}}`

function repairUnescapedQuotes(str) {
	let result = ''
	let i = 0

	while (i < str.length) {
		const char = str[i]

		// Handle escaped characters
		if (char === '\\') {
			result += char + (str[i + 1] || '')
			i += 2
			continue
		}

		// Handle string start
		if (char === '"') {
			result += char
			i++

			// Collect string content until we find the real end
			let stringContent = ''
			while (i < str.length) {
				const innerChar = str[i]

				// Handle escaped characters inside string
				if (innerChar === '\\') {
					stringContent += innerChar + (str[i + 1] || '')
					i += 2
					continue
				}

				// Check if this is the end of the string
				if (innerChar === '"') {
					// Look ahead to see if this is a structural quote
					const afterQuote = str.slice(i + 1).trimStart()
					const isStructural =
						afterQuote === '' ||
						afterQuote.startsWith(',') ||
						afterQuote.startsWith('}') ||
						afterQuote.startsWith(']') ||
						afterQuote.startsWith(':')

					if (isStructural) {
						// This is the real end of the string
						result += stringContent + innerChar
						i++
						break
					} else {
						// This is an unescaped quote inside the string
						// Find the next quote that is structural
						let j = i + 1
						let foundEnd = false
						while (j < str.length) {
							if (str[j] === '\\') {
								j += 2
								continue
							}
							if (str[j] === '"') {
								const afterThisQuote = str.slice(j + 1).trimStart()
								const isEnd =
									afterThisQuote === '' ||
									afterThisQuote.startsWith(',') ||
									afterThisQuote.startsWith('}') ||
									afterThisQuote.startsWith(']') ||
									afterThisQuote.startsWith(':')

								if (isEnd) {
									// Found the real end, replace the unescaped quote
									stringContent += '「' + str.slice(i + 1, j) + '」'
									i = j + 1
									foundEnd = true
									break
								}
							}
							j++
						}
						if (!foundEnd) {
							// Couldn't find end, just escape this quote
							stringContent += '\\"'
							i++
						}
						continue
					}
				}

				stringContent += innerChar
				i++
			}
		} else {
			result += char
			i++
		}
	}

	return result
}

console.log('Original:')
console.log(problematicJson)
console.log('\nRepaired:')
const repaired = repairUnescapedQuotes(problematicJson)
console.log(repaired)

console.log('\nTrying to parse repaired JSON...')
try {
	const parsed = JSON.parse(repaired)
	console.log('✓ Success!')
	console.log('Parsed memory field:', parsed.memory)
} catch (e) {
	console.log('✗ Failed:', e.message)
}
