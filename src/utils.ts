import Papa from 'papaparse';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import inquirer from 'inquirer';

export async function getCsvFile<T>() {
  const fileNames = readdirSync(join(__dirname, '..', 'playlists'));

  try {
    const answer = await inquirer.prompt([
      {
        type: 'list',
        name: 'file',
        message: 'Select an Item from below list',
        choices: [...fileNames, 'exit'],
      },
    ]);

    if (answer.file == 'exit') {
      process.exit();
    } else {
      console.info('Answer:', answer.file);
    }
    console.log(`Parsing file: ${answer.file}`);
    const parsedFile = readFileSync(
      join(__dirname, '..', 'playlists', answer.file),
      'utf-8'
    );
    return {
      results: Papa.parse<T>(parsedFile, {
        header: true,
      }),
      filename: answer.file
        .split('_')
        .map((word: string) => {
          if (word.includes('.csv')) word = word.substring(0, word.length - 4);
          return word.charAt(0).toUpperCase() + word.slice(1);
        })
        .join(' '),
    };
  } catch (error) {
    console.error('Error parsing csv file', error);
    throw error;
  }
}
