'use strict';
/**
 * Question generation for QUIZ ARENA.
 *
 * generateQuestions() is called ONCE per game, on the server, when the host
 * presses Start. The result is saved to the database and every player is served
 * the same questions in the same option order.
 *
 *  1. If ANTHROPIC_API_KEY is set, ask the AI for fresh questions (see ai.js).
 *  2. Anything missing or invalid -> top up (or fully fall back) from the
 *     built-in bank below (210 hand-written questions, 30 per category).
 *
 * Difficulty mix: 40% easy / 40% medium / 20% hard.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const ai = require('./ai');

const CATEGORIES = [
  { id: 'general', label: 'General Knowledge', icon: '🧠' },
  { id: 'science', label: 'Science & Technology', icon: '🔬' },
  { id: 'sports', label: 'Sports', icon: '⚽' },
  { id: 'movies', label: 'Movies & Entertainment', icon: '🎬' },
  { id: 'history', label: 'History', icon: '🏛️' },
  { id: 'geography', label: 'Geography', icon: '🌍' },
  { id: 'computers', label: 'Computers', icon: '💻' },
  { id: 'ml', label: 'Machine Learning', icon: '🤖' },
  { id: 'telugu', label: 'Telugu Movies', icon: '🎥' },
  { id: 'mixed', label: 'Mixed Questions', icon: '🎲' },
];
const CATEGORY_IDS = CATEGORIES.map((c) => c.id);

// Row format: [question, CORRECT answer, wrong, wrong, wrong]. Option order is shuffled per game.
const RAW = {
  general: {
    e: [
      ['How many continents are there on Earth?', '7', '5', '6', '8'],
      ['Which planet is known as the Red Planet?', 'Mars', 'Venus', 'Jupiter', 'Mercury'],
      ['How many colors are there in a rainbow?', '7', '6', '8', '9'],
      ['What is the largest mammal in the world?', 'Blue whale', 'African elephant', 'Giraffe', 'Hippopotamus'],
      ['Which gas do humans need to breathe to survive?', 'Oxygen', 'Nitrogen', 'Helium', 'Carbon dioxide'],
      ['How many sides does a hexagon have?', '6', '5', '7', '8'],
      ['What is the chemical formula for water?', 'H2O', 'CO2', 'O2', 'NaCl'],
      ['What is the hardest natural substance on Earth?', 'Diamond', 'Gold', 'Iron', 'Quartz'],
      ['Which animal is traditionally called the King of the Jungle?', 'Lion', 'Tiger', 'Elephant', 'Leopard'],
      ['What color do you get by mixing blue and yellow?', 'Green', 'Purple', 'Orange', 'Brown'],
      ['Which month of the year has the fewest days?', 'February', 'January', 'April', 'June'],
      ['Which direction does the Sun rise from?', 'East', 'West', 'North', 'South'],
    ],
    m: [
      ['What is the currency of Japan?', 'Yen', 'Won', 'Yuan', 'Ringgit'],
      ['Which language has the most native speakers in the world?', 'Mandarin Chinese', 'English', 'Spanish', 'Hindi'],
      ['How many bones are there in an adult human body?', '206', '212', '198', '256'],
      ['Which country gifted the Statue of Liberty to the United States?', 'France', 'England', 'Spain', 'Italy'],
      ["What does the 'www' in a web address stand for?", 'World Wide Web', 'World Web Window', 'Wide World Web', 'Web World Wire'],
      ['How many strings does a standard guitar have?', '6', '4', '5', '7'],
      ['Which festival is known as the Festival of Lights in India?', 'Diwali', 'Holi', 'Navratri', 'Eid'],
      ['Which animal is the national animal of India?', 'Bengal tiger', 'Asian lion', 'Indian elephant', 'Peacock'],
      ['What is the main ingredient of guacamole?', 'Avocado', 'Tomato', 'Cucumber', 'Green pepper'],
      ['Which is the longest bone in the human body?', 'Femur', 'Tibia', 'Humerus', 'Fibula'],
      ['What color are airplane flight recorders (black boxes) painted?', 'Bright orange', 'Black', 'Red', 'Yellow'],
      ['Which metal is liquid at room temperature?', 'Mercury', 'Lead', 'Tin', 'Aluminum'],
    ],
    h: [
      ['Which is the only letter that does not appear in the name of any US state?', 'Q', 'Z', 'X', 'J'],
      ['Which is the only mammal capable of true, sustained flight?', 'Bat', 'Flying squirrel', 'Sugar glider', 'Colugo'],
      ['What is the scientific study of fungi called?', 'Mycology', 'Phycology', 'Ornithology', 'Herpetology'],
      ['Which is the rarest of the eight main ABO/Rh blood types?', 'AB negative', 'O negative', 'B negative', 'A negative'],
      ["Which element is the most abundant in the Earth's crust by mass?", 'Oxygen', 'Silicon', 'Iron', 'Aluminum'],
      ['Which planet in our Solar System has the shortest day?', 'Jupiter', 'Saturn', 'Mars', 'Mercury'],
    ],
  },
  science: {
    e: [
      ['What is the center of an atom called?', 'Nucleus', 'Electron', 'Molecule', 'Ion'],
      ['Which planet is closest to the Sun?', 'Mercury', 'Venus', 'Earth', 'Mars'],
      ['Which force keeps us firmly on the ground?', 'Gravity', 'Magnetism', 'Friction', 'Inertia'],
      ['At sea level, at what temperature in degrees Celsius does water boil?', '100', '90', '120', '80'],
      ['Which gas do plants absorb from the air for photosynthesis?', 'Carbon dioxide', 'Oxygen', 'Nitrogen', 'Hydrogen'],
      ['How many planets are in our Solar System?', '8', '9', '7', '10'],
      ['What is the chemical symbol for gold?', 'Au', 'Ag', 'Go', 'Gd'],
      ['Which organ pumps blood around the human body?', 'Heart', 'Lungs', 'Liver', 'Kidney'],
      ['What is the closest star to Earth?', 'The Sun', 'Proxima Centauri', 'Sirius', 'Polaris'],
      ['Which of these cannot travel through a vacuum?', 'Sound', 'Light', 'Radio waves', 'X-rays'],
      ['What instrument is used to measure temperature?', 'Thermometer', 'Barometer', 'Speedometer', 'Hygrometer'],
      ['Which part of a plant absorbs water from the soil?', 'Roots', 'Leaves', 'Flowers', 'Petals'],
    ],
    m: [
      ['What is known as the powerhouse of the cell?', 'Mitochondria', 'Nucleus', 'Ribosome', 'Golgi apparatus'],
      ['What is the chemical symbol for sodium?', 'Na', 'So', 'S', 'Sd'],
      ['Which scientist developed the theory of general relativity?', 'Albert Einstein', 'Isaac Newton', 'Niels Bohr', 'Galileo Galilei'],
      ['Approximately how fast does light travel in a vacuum?', '300,000 km per second', '150,000 km per second', '30,000 km per second', '3,000,000 km per second'],
      ['What is the pH of pure water at room temperature?', '7', '0', '10', '14'],
      ['Which blood cells carry oxygen around the body?', 'Red blood cells', 'White blood cells', 'Platelets', 'Plasma cells'],
      ['What does DNA stand for?', 'Deoxyribonucleic acid', 'Dioxyribonucleic acid', 'Deoxyribose nucleic amino', 'Dynamic nucleic acid'],
      ['What does GPS stand for?', 'Global Positioning System', 'Global Position Signal', 'General Positioning Service', 'Geo Planet Satellite'],
      ['Who is credited with discovering penicillin?', 'Alexander Fleming', 'Louis Pasteur', 'Marie Curie', 'Edward Jenner'],
      ['What is the most abundant element in the universe?', 'Hydrogen', 'Helium', 'Oxygen', 'Carbon'],
      ['How many chromosomes do humans normally have in each body cell?', '46', '23', '44', '48'],
      ['What kind of energy does a moving object have?', 'Kinetic energy', 'Potential energy', 'Chemical energy', 'Nuclear energy'],
    ],
    h: [
      ['What is the name of the cell division that produces sex cells (gametes)?', 'Meiosis', 'Mitosis', 'Osmosis', 'Binary fission'],
      ['Which particle carries the electromagnetic force?', 'Photon', 'Gluon', 'Graviton', 'W boson'],
      ['Which scientist is famous for the uncertainty principle in quantum mechanics?', 'Werner Heisenberg', 'Erwin Schrödinger', 'Max Planck', 'Paul Dirac'],
      ['Roughly how old is the universe?', '13.8 billion years', '4.6 billion years', '6 billion years', '20 billion years'],
      ['Which metal has the highest melting point?', 'Tungsten', 'Iron', 'Titanium', 'Platinum'],
      ['Which vitamin does the skin produce when exposed to sunlight?', 'Vitamin D', 'Vitamin C', 'Vitamin A', 'Vitamin B12'],
    ],
  },
  sports: {
    e: [
      ['How many players does one soccer team have on the field?', '11', '9', '10', '12'],
      ['In which sport would you perform a slam dunk?', 'Basketball', 'Volleyball', 'Tennis', 'Cricket'],
      ['How many rings are on the Olympic flag?', '5', '4', '6', '7'],
      ['Which sport is played at Wimbledon?', 'Tennis', 'Golf', 'Cricket', 'Badminton'],
      ['How many points is a touchdown worth in American football, before the extra point?', '6', '7', '3', '5'],
      ['In cricket, how many runs are scored when the ball crosses the boundary without bouncing?', '6', '4', '5', '8'],
      ['Which country is the sport of sumo wrestling from?', 'Japan', 'China', 'South Korea', 'Thailand'],
      ['How many players from one team are on a basketball court at a time?', '5', '6', '7', '4'],
      ['What color card does a referee show to send a soccer player off the field?', 'Red', 'Yellow', 'Green', 'Blue'],
      ['How often are the Summer Olympic Games held?', 'Every 4 years', 'Every 2 years', 'Every 3 years', 'Every 5 years'],
      ['Which sport uses a shuttlecock?', 'Badminton', 'Squash', 'Tennis', 'Table tennis'],
      ['How many stumps are there in one wicket in cricket?', '3', '2', '4', '5'],
    ],
    m: [
      ['Which country has won the most FIFA World Cup titles?', 'Brazil', 'Germany', 'Argentina', 'Italy'],
      ['In which city were the first modern Olympic Games held in 1896?', 'Athens', 'Paris', 'London', 'Rome'],
      ['What is the official distance of a marathon?', '42.195 km', '40 km', '21.1 km', '50 km'],
      ["Which sport uses the terms 'par' and 'bogey'?", 'Golf', 'Cricket', 'Baseball', 'Rugby'],
      ['How many players from one team are on the field in baseball?', '9', '11', '10', '8'],
      ['Which city hosted the 2016 Summer Olympics?', 'Rio de Janeiro', 'Beijing', 'London', 'Tokyo'],
      ['In tennis, what is a score of zero called?', 'Love', 'Nil', 'Zero', 'Duck'],
      ['Which Indian cricketer is nicknamed the Master Blaster?', 'Sachin Tendulkar', 'Virat Kohli', 'MS Dhoni', 'Rahul Dravid'],
      ['Who has won the most Olympic gold medals of all time?', 'Michael Phelps', 'Usain Bolt', 'Carl Lewis', 'Mark Spitz'],
      ['Which team won the first Cricket World Cup in 1975?', 'West Indies', 'Australia', 'England', 'India'],
      ['In which sport is the Stanley Cup awarded?', 'Ice hockey', 'Basketball', 'Baseball', 'Soccer'],
      ['How many Grand Slam tournaments are there in tennis each year?', '4', '3', '5', '6'],
    ],
    h: [
      ['Which country won the first FIFA World Cup in 1930?', 'Uruguay', 'Brazil', 'Argentina', 'Italy'],
      ['In which year did India win its first Cricket World Cup?', '1983', '1975', '1987', '1992'],
      ['Which player scored the famous "Hand of God" goal at the 1986 World Cup?', 'Diego Maradona', 'Pelé', 'Lionel Messi', 'Zinedine Zidane'],
      ['How many players from one team are on the ice in ice hockey, including the goalkeeper?', '6', '5', '7', '11'],
      ['In which year were the first Winter Olympics held at Chamonix?', '1924', '1896', '1936', '1948'],
      ['Who was the first gymnast to score a perfect 10 at the Olympics?', 'Nadia Comăneci', 'Olga Korbut', 'Simone Biles', 'Larisa Latynina'],
    ],
  },
  movies: {
    e: [
      ['Which animated movie features a clownfish named Nemo?', 'Finding Nemo', 'Shark Tale', 'Moana', 'The Little Mermaid'],
      ['Which boy wizard attends Hogwarts School of Witchcraft and Wizardry?', 'Harry Potter', 'Percy Jackson', 'Peter Pan', 'Frodo Baggins'],
      ['In The Lion King, what is the name of the young lion who becomes king?', 'Simba', 'Mufasa', 'Scar', 'Nala'],
      ["Which Disney movie features the song 'Let It Go'?", 'Frozen', 'Tangled', 'Moana', 'Brave'],
      ['Which actor plays Iron Man in the Marvel Cinematic Universe?', 'Robert Downey Jr.', 'Chris Evans', 'Chris Hemsworth', 'Mark Ruffalo'],
      ['What is the name of the toy cowboy in Toy Story?', 'Woody', 'Buzz', 'Rex', 'Slinky'],
      ['Which 1975 thriller features a giant shark terrorizing a beach town?', 'Jaws', 'Titanic', 'Avatar', 'Jurassic Park'],
      ['What type of creature is Shrek?', 'An ogre', 'A troll', 'A giant', 'A goblin'],
      ['What is the name of the fictional African nation in Black Panther?', 'Wakanda', 'Zamunda', 'Genovia', 'Latveria'],
      ['Who played Jack Dawson in Titanic?', 'Leonardo DiCaprio', 'Brad Pitt', 'Johnny Depp', 'Tom Cruise'],
      ['What color pill does Neo take in The Matrix to see the truth?', 'Red', 'Blue', 'Green', 'Yellow'],
      ['Which Bollywood star is widely nicknamed the King of Bollywood?', 'Shah Rukh Khan', 'Salman Khan', 'Aamir Khan', 'Hrithik Roshan'],
    ],
    m: [
      ['Who directed the 1993 film Jurassic Park?', 'Steven Spielberg', 'James Cameron', 'George Lucas', 'Ridley Scott'],
      ['Who directed The Dark Knight trilogy?', 'Christopher Nolan', 'Zack Snyder', 'Tim Burton', 'Matt Reeves'],
      ['Which band performed Bohemian Rhapsody?', 'Queen', 'The Beatles', 'Led Zeppelin', 'Pink Floyd'],
      ['Which actress played Katniss Everdeen in The Hunger Games films?', 'Jennifer Lawrence', 'Emma Stone', 'Shailene Woodley', 'Kristen Stewart'],
      ['In which fictional city does Batman operate?', 'Gotham City', 'Metropolis', 'Star City', 'Central City'],
      ["Which Indian film's song Naatu Naatu won the Oscar for Best Original Song?", 'RRR', 'Pathaan', 'Gully Boy', 'Lagaan'],
      ['Who composed the music for Slumdog Millionaire and won two Oscars for it?', 'A. R. Rahman', 'Hans Zimmer', 'Ilaiyaraaja', 'Pritam'],
      ['Which TV series features the Iron Throne?', 'Game of Thrones', 'The Witcher', 'Vikings', 'Lost'],
      ['Who is the lead singer of the Irish rock band U2?', 'Bono', 'Sting', 'Bruce Springsteen', 'Mick Jagger'],
      ['Which 1994 film follows a kind-hearted man who unknowingly takes part in major moments of American history?', 'Forrest Gump', 'Big Fish', 'Cast Away', 'The Truman Show'],
      ['Which Netflix series features a place called the Upside Down?', 'Stranger Things', 'Dark', 'Black Mirror', 'The OA'],
      ['Who voices Woody in the original Toy Story films?', 'Tom Hanks', 'Tim Allen', 'Billy Crystal', 'Robin Williams'],
    ],
    h: [
      ['Who directed Pulp Fiction?', 'Quentin Tarantino', 'Martin Scorsese', 'David Fincher', 'Joel and Ethan Coen'],
      ['Which actress has won the most competitive acting Oscars, with four?', 'Katharine Hepburn', 'Meryl Streep', 'Frances McDormand', 'Ingrid Bergman'],
      ['In which year was the first Star Wars film released?', '1977', '1980', '1975', '1983'],
      ['Who directed the film Parasite?', 'Bong Joon-ho', 'Park Chan-wook', 'Hirokazu Kore-eda', 'Wong Kar-wai'],
      ['Which 2000 film features a Roman general named Maximus?', 'Gladiator', 'Troy', 'Ben-Hur', '300'],
      ['Which film tied the record of 11 Academy Awards with Ben-Hur and Titanic?', 'The Lord of the Rings: The Return of the King', 'Gladiator', 'Avatar', 'La La Land'],
    ],
  },
  history: {
    e: [
      ['Who was the first President of the United States?', 'George Washington', 'Abraham Lincoln', 'Thomas Jefferson', 'John Adams'],
      ['In which country are the Great Pyramids of Giza?', 'Egypt', 'Mexico', 'Sudan', 'Iraq'],
      ['Who was the first person to walk on the Moon?', 'Neil Armstrong', 'Buzz Aldrin', 'Yuri Gagarin', 'Michael Collins'],
      ['Which ship sank in 1912 after hitting an iceberg?', 'Titanic', 'Lusitania', 'Britannic', 'Bismarck'],
      ['Which wall fell in 1989, symbolizing the end of the Cold War?', 'Berlin Wall', 'Great Wall of China', "Hadrian's Wall", 'Western Wall'],
      ['Who is known as the Father of the Nation in India?', 'Mahatma Gandhi', 'Jawaharlal Nehru', 'Subhas Chandra Bose', 'Sardar Patel'],
      ['In which year did India gain independence?', '1947', '1950', '1942', '1935'],
      ['Which ancient civilization built Machu Picchu?', 'Inca', 'Aztec', 'Maya', 'Olmec'],
      ['Which explorer reached the Americas in 1492 on a voyage funded by Spain?', 'Christopher Columbus', 'Vasco da Gama', 'Ferdinand Magellan', 'Marco Polo'],
      ['Julius Caesar was a famous leader of which ancient civilization?', 'Rome', 'Greece', 'Egypt', 'Persia'],
      ['Which major war ended in 1945?', 'World War II', 'World War I', 'The Korean War', 'The Vietnam War'],
      ['Who was the first Prime Minister of India?', 'Jawaharlal Nehru', 'Sardar Patel', 'Lal Bahadur Shastri', 'Indira Gandhi'],
    ],
    m: [
      ['In which year did World War I begin?', '1914', '1912', '1916', '1918'],
      ['Who was the British Prime Minister for most of World War II?', 'Winston Churchill', 'Neville Chamberlain', 'Clement Attlee', 'Margaret Thatcher'],
      ['Which ancient empire built the Colosseum?', 'Roman Empire', 'Greek city-states', 'Byzantine Empire', 'Ottoman Empire'],
      ['Who led the Salt March (Dandi March) in 1930?', 'Mahatma Gandhi', 'Bhagat Singh', 'Jawaharlal Nehru', 'Bal Gangadhar Tilak'],
      ['Which Mughal emperor built the Taj Mahal?', 'Shah Jahan', 'Akbar', 'Aurangzeb', 'Humayun'],
      ['In which year did the French Revolution begin?', '1789', '1776', '1804', '1815'],
      ['Who became the first emperor of a unified China in 221 BC?', 'Qin Shi Huang', 'Kublai Khan', 'Sun Yat-sen', 'Liu Bang'],
      ['Which treaty formally ended World War I with Germany?', 'Treaty of Versailles', 'Treaty of Paris', 'Treaty of Vienna', 'Treaty of Tordesillas'],
      ["Which battle in 1815 ended Napoleon's rule as Emperor of the French?", 'Waterloo', 'Trafalgar', 'Austerlitz', 'Borodino'],
      ['Which ancient wonder stood in the Egyptian city of Alexandria?', 'The Lighthouse (Pharos)', 'Hanging Gardens', 'Colossus', 'Temple of Artemis'],
      ['Who founded the Maurya Empire in India?', 'Chandragupta Maurya', 'Ashoka', 'Bindusara', 'Harsha'],
      ['In which year did Apollo 11 land humans on the Moon?', '1969', '1965', '1972', '1961'],
    ],
    h: [
      ['Which 1757 battle laid the foundation of British rule in India?', 'Battle of Plassey', 'Battle of Panipat', 'Battle of Haldighati', 'Battle of Wandiwash'],
      ['Who was the last Mughal emperor?', 'Bahadur Shah Zafar', 'Aurangzeb', 'Shah Alam II', 'Akbar II'],
      ['Which Roman emperor issued the Edict of Milan in 313 AD, tolerating Christianity?', 'Constantine', 'Nero', 'Augustus', 'Diocletian'],
      ['In which year did the Soviet Union dissolve?', '1991', '1989', '1985', '1993'],
      ['Which Chola king built the Brihadeeswarar Temple in Thanjavur?', 'Rajaraja Chola I', 'Rajendra Chola I', 'Karikala Chola', 'Vijayalaya Chola'],
      ['Cleopatra VII belonged to which ruling dynasty of Egypt?', 'Ptolemaic dynasty', 'Seleucid dynasty', 'Achaemenid dynasty', 'Antigonid dynasty'],
    ],
  },
  geography: {
    e: [
      ['What is the capital of France?', 'Paris', 'Lyon', 'Marseille', 'Nice'],
      ['Which is the largest ocean on Earth?', 'Pacific Ocean', 'Atlantic Ocean', 'Indian Ocean', 'Arctic Ocean'],
      ['Which is the longest river in Africa?', 'Nile', 'Congo', 'Niger', 'Zambezi'],
      ['What is the capital of Japan?', 'Tokyo', 'Osaka', 'Kyoto', 'Hiroshima'],
      ['On which continent is the Sahara Desert?', 'Africa', 'Asia', 'Australia', 'South America'],
      ['What is the highest mountain in the world above sea level?', 'Mount Everest', 'K2', 'Kangchenjunga', 'Kilimanjaro'],
      ['Which European country is shaped like a boot?', 'Italy', 'Spain', 'Greece', 'Portugal'],
      ['What is the capital of India?', 'New Delhi', 'Mumbai', 'Kolkata', 'Chennai'],
      ['Which is the largest country in the world by area?', 'Russia', 'Canada', 'China', 'United States'],
      ['On which continent is Brazil located?', 'South America', 'North America', 'Africa', 'Europe'],
      ['In which ocean are the Maldives located?', 'Indian Ocean', 'Pacific Ocean', 'Atlantic Ocean', 'Arctic Ocean'],
      ['What is the capital of the United States?', 'Washington, D.C.', 'New York City', 'Los Angeles', 'Chicago'],
    ],
    m: [
      ['What is the capital of Australia?', 'Canberra', 'Sydney', 'Melbourne', 'Brisbane'],
      ['Which is the largest hot desert in the world?', 'Sahara', 'Arabian Desert', 'Gobi Desert', 'Kalahari Desert'],
      ['Which river is considered the holiest in Hinduism?', 'Ganga (Ganges)', 'Yamuna', 'Godavari', 'Narmada'],
      ['What is the capital of Canada?', 'Ottawa', 'Toronto', 'Vancouver', 'Montreal'],
      ['Which is the smallest country in the world by area?', 'Vatican City', 'Monaco', 'Nauru', 'San Marino'],
      ['Which African country has the largest population?', 'Nigeria', 'Ethiopia', 'Egypt', 'South Africa'],
      ['In which country is Mount Kilimanjaro located?', 'Tanzania', 'Kenya', 'Uganda', 'Ethiopia'],
      ['Which strait separates Spain from Morocco?', 'Strait of Gibraltar', 'Bosphorus', 'Strait of Hormuz', 'Bering Strait'],
      ['Which is the deepest known ocean trench?', 'Mariana Trench', 'Java Trench', 'Puerto Rico Trench', 'Tonga Trench'],
      ['Which Indian state has the longest coastline?', 'Gujarat', 'Tamil Nadu', 'Andhra Pradesh', 'Maharashtra'],
      ['What is the capital city of Brazil?', 'Brasília', 'Rio de Janeiro', 'São Paulo', 'Salvador'],
      ['Which is the largest lake in the world by surface area?', 'Caspian Sea', 'Lake Superior', 'Lake Victoria', 'Lake Baikal'],
    ],
    h: [
      ['Which country borders both the Caspian Sea and the Persian Gulf?', 'Iran', 'Iraq', 'Turkmenistan', 'Azerbaijan'],
      ['What is the capital of Kazakhstan?', 'Astana', 'Almaty', 'Tashkent', 'Bishkek'],
      ['Which river flows through the city of Baghdad?', 'Tigris', 'Euphrates', 'Nile', 'Jordan'],
      ["Which is the world's tallest uninterrupted waterfall?", 'Angel Falls', 'Victoria Falls', 'Niagara Falls', 'Iguazu Falls'],
      ['What is the capital of Myanmar?', 'Naypyidaw', 'Yangon', 'Mandalay', 'Bago'],
      ['Lake Titicaca lies on the border between Peru and which country?', 'Bolivia', 'Chile', 'Ecuador', 'Argentina'],
    ],
  },
  computers: {
    e: [
      ['What does CPU stand for?', 'Central Processing Unit', 'Central Program Unit', 'Computer Personal Unit', 'Core Processing Utility'],
      ['Which of these is an input device?', 'Keyboard', 'Monitor', 'Printer', 'Speaker'],
      ['What does USB stand for?', 'Universal Serial Bus', 'Universal System Bus', 'United Serial Bus', 'Unique Serial Backup'],
      ['Which company created the Windows operating system?', 'Microsoft', 'Apple', 'Google', 'IBM'],
      ['Which company develops the Android operating system?', 'Google', 'Apple', 'Microsoft', 'Nokia'],
      ['What does RAM stand for?', 'Random Access Memory', 'Read Access Memory', 'Rapid Action Memory', 'Run Active Memory'],
      ['Which keyboard shortcut copies selected text on Windows?', 'Ctrl + C', 'Ctrl + V', 'Ctrl + X', 'Ctrl + Z'],
      ['Which language is used to style web pages?', 'CSS', 'HTML', 'Python', 'SQL'],
      ['What does PDF stand for?', 'Portable Document Format', 'Printed Document File', 'Personal Data Format', 'Public Display Form'],
      ['Which symbol separates the username and domain in an email address?', '@', '#', '&', '$'],
      ['How many bits are there in one byte?', '8', '4', '16', '10'],
      ['What is the name for malicious software designed to harm a computer?', 'Malware', 'Firmware', 'Freeware', 'Shareware'],
    ],
    m: [
      ['What does HTML stand for?', 'HyperText Markup Language', 'HyperText Machine Language', 'HighText Markup Language', 'Hyperlink Text Mark Language'],
      ['Who co-founded Microsoft with Bill Gates?', 'Paul Allen', 'Steve Jobs', 'Steve Wozniak', 'Larry Page'],
      ['What does SQL stand for?', 'Structured Query Language', 'Simple Query Language', 'Standard Question Language', 'Sequential Query Logic'],
      ['The Python programming language is named after which British comedy group?', 'Monty Python', 'The Goodies', 'Blackadder', 'The Two Ronnies'],
      ['What does HTTP stand for?', 'HyperText Transfer Protocol', 'HyperText Transmission Process', 'High Transfer Text Protocol', 'Hyperlink Text Transfer Program'],
      ['What is the decimal number 5 in binary?', '101', '110', '100', '111'],
      ['Which of these is a relational database?', 'MySQL', 'MongoDB', 'Redis', 'Cassandra'],
      ['Who created the Linux kernel?', 'Linus Torvalds', 'Richard Stallman', 'Dennis Ritchie', 'Bill Joy'],
      ['What does IP stand for in IP address?', 'Internet Protocol', 'Internal Process', 'Interface Port', 'Internet Provider'],
      ['Which data structure follows the Last-In-First-Out (LIFO) principle?', 'Stack', 'Queue', 'Array', 'Binary tree'],
      ['What does URL stand for?', 'Uniform Resource Locator', 'Universal Resource Link', 'Uniform Retrieval Locator', 'Unified Resource Location'],
      ['Which protocol is used to securely browse websites?', 'HTTPS', 'FTP', 'SMTP', 'Telnet'],
    ],
    h: [
      ['Which sorting algorithm picks a pivot element and partitions the array around it?', 'Quick Sort', 'Bubble Sort', 'Insertion Sort', 'Selection Sort'],
      ['Which layer of the OSI model is responsible for routing packets between networks?', 'Network layer', 'Transport layer', 'Data link layer', 'Session layer'],
      ['What is the default port number for HTTPS?', '443', '80', '8080', '21'],
      ['Who designed the Analytical Engine, an early concept of a mechanical general-purpose computer?', 'Charles Babbage', 'Alan Turing', 'John von Neumann', 'Ada Lovelace'],
      ["In database ACID properties, what does the 'I' stand for?", 'Isolation', 'Integrity', 'Indexing', 'Iteration'],
      ['What is the time complexity of binary search on a sorted array?', 'O(log n)', 'O(n)', 'O(n log n)', 'O(1)'],
    ],
  },
  ml: {
    e: [
      ['What does ML stand for in technology?', 'Machine Learning', 'Multi Language', 'Mobile Logic', 'Memory Layer'],
      ['What does AI stand for?', 'Artificial Intelligence', 'Automated Interface', 'Applied Information', 'Analog Integration'],
      ['Which programming language is the most popular for machine learning?', 'Python', 'HTML', 'CSS', 'SQL'],
      ['Learning from examples that already have the correct answers attached is called what?', 'Supervised learning', 'Unsupervised learning', 'Reinforcement learning', 'Quantum learning'],
      ['What is the data used to teach a model called?', 'Training data', 'Test results', 'Source code', 'Firmware'],
      ['Which of these machine learning libraries was created by Google?', 'TensorFlow', 'Photoshop', 'Excel', 'Unity'],
      ['PyTorch was originally developed by which company?', 'Meta (Facebook)', 'Google', 'Microsoft', 'Apple'],
      ['ChatGPT is an example of what kind of AI system?', 'Large language model', 'Spreadsheet program', 'Operating system', 'Image sensor'],
      ["In machine learning, what is a 'feature'?", 'An input variable used to make a prediction', 'The final output of a model', 'A bug in the code', 'A type of computer chip'],
      ['Predicting a number, such as the price of a house, is which type of task?', 'Regression', 'Classification', 'Clustering', 'Compression'],
      ['Which family of algorithms is loosely inspired by the human brain?', 'Neural networks', 'Linked lists', 'Hash tables', 'Binary trees'],
      ['Which of these is a common computer vision task?', 'Recognizing objects in images', 'Sorting a spreadsheet', 'Compiling code', 'Sending email'],
    ],
    m: [
      ['What does CNN stand for in deep learning?', 'Convolutional Neural Network', 'Central Neural Node', 'Connected Number Network', 'Cascaded Neuron Net'],
      ['What is overfitting?', 'A model memorizes its training data and does poorly on new data', 'A model is too simple to learn anything', 'Training runs too fast', 'The computer runs out of memory'],
      ['Which technique keeps some data aside so a model can be tested on examples it has never seen?', 'Train-test split', 'Data compression', 'Garbage collection', 'Hot swapping'],
      ['Which of these algorithms is used for clustering?', 'K-means', 'Linear regression', 'Logistic regression', 'Naive Bayes'],
      ['Why are GPUs popular for training neural networks?', 'They perform many calculations in parallel', 'They store more files', 'They have bigger screens', 'They use no electricity'],
      ['Which activation function outputs max(0, x)?', 'ReLU', 'Sigmoid', 'Softmax', 'Tanh'],
      ['What does gradient descent do?', 'Adjusts model parameters to reduce the loss', 'Sorts the training data', 'Encrypts the dataset', 'Draws graphs of results'],
      ["Which architecture was introduced in the 2017 paper 'Attention Is All You Need'?", 'Transformer', 'LSTM', 'Perceptron', 'Autoencoder'],
      ['What does NLP stand for in AI?', 'Natural Language Processing', 'Neural Logic Programming', 'Network Layer Protocol', 'Numeric Learning Process'],
      ["In supervised learning, what is a 'label'?", 'The known correct output for a training example', 'The name of the data file', 'The size of the model', 'A GPU setting'],
      ['Which metric is the share of predictions that a model got right?', 'Accuracy', 'Latency', 'Bandwidth', 'Entropy'],
      ['Which Python library is widely used for data analysis with DataFrames?', 'Pandas', 'Flask', 'Pygame', 'Django'],
    ],
    h: [
      ['Which researcher shared the 2018 Turing Award with Geoffrey Hinton and Yann LeCun?', 'Yoshua Bengio', 'Andrew Ng', 'Demis Hassabis', 'Fei-Fei Li'],
      ['What is the vanishing gradient problem?', 'Gradients shrink toward zero in the early layers of deep networks', 'The model runs out of memory', 'Labels become incorrect over time', 'The dataset gets deleted'],
      ['Which metric is the harmonic mean of precision and recall?', 'F1 score', 'AUC', 'RMSE', 'R-squared'],
      ['Which early neural network model was invented by Frank Rosenblatt in 1958?', 'Perceptron', 'Transformer', 'Boltzmann machine', 'Autoencoder'],
      ['Q-learning belongs to which learning paradigm?', 'Reinforcement learning', 'Supervised learning', 'Unsupervised learning', 'Semi-supervised learning'],
      ['What effect does L1 (Lasso) regularization tend to have on weights?', 'Pushes some weights to exactly zero', 'Makes all weights larger', 'Adds more layers', 'Doubles the learning rate'],
    ],
  },
  telugu: {
    e: [
      ['Who directed Baahubali: The Beginning?', 'S. S. Rajamouli', 'Trivikram Srinivas', 'Sukumar', 'Puri Jagannadh'],
      ['Which actor played the title role in Baahubali: The Beginning?', 'Prabhas', 'Rana Daggubati', 'Allu Arjun', 'Mahesh Babu'],
      ['Which actor played Pushpa Raj in Pushpa: The Rise?', 'Allu Arjun', 'Ram Charan', 'Vijay Deverakonda', 'Nani'],
      ["Which Telugu film's song 'Naatu Naatu' won the Oscar for Best Original Song?", 'RRR', 'Pushpa', 'Magadheera', 'Eega'],
      ['Who played Komaram Bheem in RRR?', 'N. T. Rama Rao Jr.', 'Ram Charan', 'Ajay Devgn', 'Prabhas'],
      ['Who played Alluri Sitarama Raju in RRR?', 'Ram Charan', 'N. T. Rama Rao Jr.', 'Allu Arjun', 'Nani'],
      ['Which actor is known as the Megastar of Telugu cinema?', 'Chiranjeevi', 'Nagarjuna', 'Venkatesh', 'Balakrishna'],
      ['Which actor is known by the title Power Star?', 'Pawan Kalyan', 'Mahesh Babu', 'Ravi Teja', 'Nani'],
      ['Which actor is nicknamed the Prince of Tollywood?', 'Mahesh Babu', 'Prabhas', 'Ram Charan', 'Allu Arjun'],
      ['What is the Telugu film industry commonly nicknamed?', 'Tollywood', 'Kollywood', 'Sandalwood', 'Mollywood'],
      ['In which city is Ramoji Film City, one of the largest film studio complexes in the world?', 'Hyderabad', 'Vijayawada', 'Visakhapatnam', 'Chennai'],
      ['Who played the lead role in the film Arjun Reddy?', 'Vijay Deverakonda', 'Nani', 'Naga Chaitanya', 'Varun Tej'],
    ],
    m: [
      ["Which 2017 film answered the question 'Why did Kattappa kill Baahubali?'", 'Baahubali 2: The Conclusion', 'Magadheera', 'Pushpa 2: The Rule', 'Sye'],
      ['Who directed Pushpa: The Rise?', 'Sukumar', 'Sandeep Reddy Vanga', 'Koratala Siva', 'Boyapati Srinu'],
      ['Who directed Arjun Reddy?', 'Sandeep Reddy Vanga', 'Sukumar', 'Trivikram Srinivas', 'Krish Jagarlamudi'],
      ['Which 2009 film, starring Ram Charan and directed by S. S. Rajamouli, is a story of reincarnation?', 'Magadheera', 'Eega', 'Chatrapathi', 'Vikramarkudu'],
      ['In Rajamouli\'s film Eega, the hero is reborn as what?', 'A housefly', 'A cat', 'A snake', 'A crow'],
      ['Who composed the music for RRR?', 'M. M. Keeravani', 'Devi Sri Prasad', 'Thaman S', 'A. R. Rahman'],
      ["Who wrote the lyrics of 'Naatu Naatu'?", 'Chandrabose', 'Sirivennela Seetharama Sastry', 'Ramajogayya Sastry', 'Anantha Sriram'],
      ['Which actor played Chitti Babu in Rangasthalam (2018)?', 'Ram Charan', 'Nani', 'Allu Arjun', 'Sai Dharam Tej'],
      ['In which 2018 film does Mahesh Babu play a young Chief Minister?', 'Bharat Ane Nenu', 'Srimanthudu', 'Maharshi', 'Pokiri'],
      ['Which 2006 blockbuster starring Mahesh Babu was directed by Puri Jagannadh?', 'Pokiri', 'Athadu', 'Dookudu', 'Okkadu'],
      ['Who played the lead role in the cricket drama Jersey (2019)?', 'Nani', 'Vijay Deverakonda', 'Ram Pothineni', 'Sharwanand'],
      ['Which actress played the legendary Savitri in the biopic Mahanati (2018)?', 'Keerthy Suresh', 'Samantha', 'Anushka Shetty', 'Rashmika Mandanna'],
    ],
    h: [
      ['Which film is considered the first Telugu talkie?', 'Bhakta Prahlada', 'Mayabazar', 'Lava Kusa', 'Devadasu'],
      ['Who directed the classic fantasy film Mayabazar (1957)?', 'K. V. Reddy', 'B. N. Reddy', 'L. V. Prasad', 'Adurthi Subba Rao'],
      ['Which legendary Telugu actor founded the Telugu Desam Party and became Chief Minister of Andhra Pradesh?', 'N. T. Rama Rao', 'Akkineni Nageswara Rao', 'Krishna', 'Chiranjeevi'],
      ['Who directed the classic musical Shankarabharanam (1980)?', 'K. Viswanath', 'Bapu', 'Dasari Narayana Rao', 'K. Raghavendra Rao'],
      ['Who composed the music for Shankarabharanam?', 'K. V. Mahadevan', 'Ilaiyaraaja', 'M. S. Viswanathan', 'Chakravarthy'],
      ['Which actor played Lt. Ram in the 2022 film Sita Ramam?', 'Dulquer Salmaan', 'Nani', 'Naga Chaitanya', 'Vijay Deverakonda'],
    ],
  },
};

const DIFF = { e: 'easy', m: 'medium', h: 'hard' };
const DIFFS = ['easy', 'medium', 'hard'];
const BANK = [];
for (const [cat, levels] of Object.entries(RAW)) {
  for (const [k, rows] of Object.entries(levels)) {
    for (const row of rows) {
      BANK.push({ category: cat, difficulty: DIFF[k], text: row[0], answer: row[1], wrong: row.slice(2) });
    }
  }
}

const norm = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const rfloat = () => crypto.randomInt(0, 1_000_000) / 1_000_000;

/**
 * Optional: add your own questions without touching the code.
 * Put them in custom-questions.json (or point CUSTOM_QUESTIONS at another file). See custom-questions.example.json.
 * Each item: { "category": "telugu", "difficulty": "easy|medium|hard", "question": "...", "answer": "...", "wrong": ["...", "...", "..."] }
 */
function loadCustomQuestions() {
  const file = process.env.CUSTOM_QUESTIONS || path.join(__dirname, 'custom-questions.json');
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return; }
  let items;
  try { items = JSON.parse(raw); } catch (e) { console.warn(`[questions] ${file} is not valid JSON (${e.message}); ignoring it`); return; }
  if (!Array.isArray(items)) { console.warn('[questions] custom questions file must contain a JSON array; ignoring it'); return; }
  let added = 0;
  items.forEach((it, i) => {
    const bad = (why) => console.warn(`[questions] custom question #${i + 1} skipped: ${why}`);
    if (!it || typeof it !== 'object') return bad('not an object');
    if (!CATEGORY_IDS.includes(it.category) || it.category === 'mixed') return bad(`unknown category "${it.category}" (use one of: ${CATEGORY_IDS.filter((c) => c !== 'mixed').join(', ')})`);
    if (!DIFFS.includes(it.difficulty)) return bad('difficulty must be easy, medium or hard');
    const wrong = Array.isArray(it.wrong) ? it.wrong.map((w) => String(w).trim()) : [];
    const opts = [String(it.answer || '').trim(), ...wrong];
    if (typeof it.question !== 'string' || it.question.trim().length < 10) return bad('"question" is missing or too short');
    if (wrong.length !== 3 || opts.some((o) => !o) || new Set(opts.map((o) => o.toLowerCase())).size !== 4) return bad('needs one "answer" and exactly 3 different, non-empty "wrong" answers');
    if (BANK.some((b) => norm(b.text) === norm(it.question))) return bad('duplicate of an existing question');
    BANK.push({ category: it.category, difficulty: it.difficulty, text: it.question.trim(), answer: opts[0], wrong: opts.slice(1) });
    added++;
  });
  if (added) console.log(`[questions] loaded ${added} custom question(s) from ${path.basename(file)}`);
}
loadCustomQuestions();

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 40% easy / 40% medium / 20% hard (10 -> 4/4/2, 12 -> 5/5/2, 15 -> 6/6/3). */
function plan(n) {
  const hard = Math.round(n * 0.2);
  const easy = Math.round(n * 0.4);
  return { easy, medium: n - easy - hard, hard };
}

function toQuestion(b) {
  const options = shuffle([b.answer, ...b.wrong]);
  return { text: b.text, options, correctIdx: options.indexOf(b.answer), difficulty: b.difficulty, category: b.category };
}

function pickFromBank({ category, counts, avoid, chosen }) {
  const out = [];
  for (const diff of DIFFS) {
    let need = counts[diff] || 0;
    if (need <= 0) continue;
    const cats = category === 'mixed' ? CATEGORY_IDS.filter((c) => c !== 'mixed') : [category];
    const pools = shuffle(cats).map((c) => {
      const all = BANK.filter((b) => b.category === c && b.difficulty === diff && !chosen.has(norm(b.text)));
      // Questions this room has not seen yet come first; seen ones only if we run out.
      return shuffle(all.filter((b) => !avoid.has(norm(b.text)))).concat(shuffle(all.filter((b) => avoid.has(norm(b.text)))));
    });
    let i = 0;
    while (need > 0 && pools.some((p) => p.length)) {
      const pool = pools[i % pools.length];
      i++;
      if (!pool.length) continue;
      const b = pool.shift();
      chosen.add(norm(b.text));
      out.push(toQuestion(b));
      need--;
    }
  }
  return out;
}

const clean = (s, max) => String(s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** Validate one AI-produced question. Returns a normalized question or null. */
function validate(item, categoryId) {
  if (!item || typeof item !== 'object') return null;
  const text = typeof item.text === 'string' ? clean(item.text, 300) : '';
  if (text.length < 10) return null;
  if (!Array.isArray(item.options) || item.options.length !== 4) return null;
  const options = item.options.map((o) => (typeof o === 'string' || typeof o === 'number' ? clean(o, 120) : ''));
  if (options.some((o) => !o) || new Set(options.map(norm)).size !== 4) return null;
  const correctIdx = Number.isInteger(item.correct) ? item.correct : -1;
  if (correctIdx < 0 || correctIdx > 3) return null;
  const difficulty = DIFFS.includes(item.difficulty) ? item.difficulty : 'medium';
  const category = CATEGORY_IDS.includes(item.category) && item.category !== 'mixed' ? item.category : categoryId === 'mixed' ? 'general' : categoryId;
  return { text, options, correctIdx, difficulty, category };
}

/** Mostly easy first, hard later, with some randomness so it is not predictable. */
function order(questions) {
  const rank = { easy: 0, medium: 1, hard: 2 };
  return questions
    .map((q) => ({ q, k: rank[q.difficulty] + rfloat() * 1.6 }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.q);
}

/**
 * @param {{category:string, n:number, avoid?:string[]}} opts  avoid = question texts this room already played
 * @returns {Promise<{questions:Array, source:'ai'|'ai+bank'|'bank'}>}
 */
async function generateQuestions({ category, n, avoid = [] }) {
  const counts = plan(n);
  const avoidSet = new Set(avoid.map(norm));
  const chosen = new Set();
  let questions = [];
  let usedAI = false;

  if (ai.isConfigured()) {
    try {
      const label = CATEGORIES.find((c) => c.id === category).label;
      const raw = await ai.generate({ categoryId: category, label, n, counts, avoid: avoid.slice(-40) });
      const valid = [];
      for (const item of raw) {
        const v = validate(item, category);
        if (!v) continue;
        const key = norm(v.text);
        if (chosen.has(key) || avoidSet.has(key)) continue;
        chosen.add(key);
        valid.push(v);
      }
      // Prefer the requested difficulty mix, then fill with whatever else is valid.
      const picked = [];
      for (const d of DIFFS) picked.push(...valid.filter((v) => v.difficulty === d).slice(0, counts[d]));
      for (const v of valid) if (picked.length < n && !picked.includes(v)) picked.push(v);
      questions = picked.slice(0, n);
      usedAI = questions.length > 0;
      chosen.clear();
      questions.forEach((q) => chosen.add(norm(q.text)));
    } catch (e) {
      console.warn(`[questions] AI generation failed (${e.message}); using the question bank`);
      questions = [];
      chosen.clear();
    }
  }

  const aiCount = usedAI ? questions.length : 0;
  if (questions.length < n) {
    const deficit = n - questions.length;
    const have = { easy: 0, medium: 0, hard: 0 };
    questions.forEach((q) => have[q.difficulty]++);
    const need = {};
    for (const d of DIFFS) need[d] = Math.max(0, counts[d] - have[d]);
    let sum = DIFFS.reduce((s, d) => s + need[d], 0);
    while (sum > deficit) { const d = DIFFS.slice().sort((a, b) => need[b] - need[a])[0]; need[d]--; sum--; }
    while (sum < deficit) { need.medium++; sum++; }
    questions = questions.concat(pickFromBank({ category, counts: need, avoid: avoidSet, chosen }));
  }

  const source = aiCount === 0 ? 'bank' : aiCount >= n ? 'ai' : 'ai+bank';
  return { questions: order(questions).slice(0, n), source };
}

module.exports = { CATEGORIES, CATEGORY_IDS, BANK, plan, generateQuestions, pickFromBank, validate, norm };
